import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockR2Bucket, MockR2Bucket } from './mocks/r2-bucket.mock'
import { createMockFetch, createFailingMockFetch, MOCK_USERS } from './mocks/twitter-api.mock'

// Import the worker
import worker from '../src/index'

// Mock the global fetch function
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('Cloudflare Worker - Cache Isolation Tests', () => {
  let env: any

  beforeEach(() => {
    // Reset mocks before each test
    mockR2Bucket.clear()
    mockFetch.mockReset()
    
    // Setup test environment
    env = {
      MY_BUCKET: mockR2Bucket,
      TWITTER_BEARER_TOKEN: 'test-bearer-token'
    }
  })

  describe('Cache Key Generation', () => {
    it('should use userid-specific cache keys', async () => {
      const moonwellUserId = MOCK_USERS.MOONWELL_DEFI.id
      const mamoUserId = MOCK_USERS.MAMO_AGENT.id

      // Setup mock fetch to return different data for each user
      mockFetch.mockImplementation(createMockFetch())

      // Make requests for different users
      const moonwellRequest = new Request(`https://example.com?userid=${moonwellUserId}`)
      const mamoRequest = new Request(`https://example.com?userid=${mamoUserId}`)

      await worker.fetch(moonwellRequest, env)
      await worker.fetch(mamoRequest, env)

      // Verify separate cache keys were created
      const cacheKeys = mockR2Bucket.keys()
      expect(cacheKeys).toContain(`${moonwellUserId}.json`)
      expect(cacheKeys).toContain(`${mamoUserId}.json`)
      expect(cacheKeys).toHaveLength(2)
    })

    it('should use default userid when none provided', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const request = new Request('https://example.com')
      await worker.fetch(request, env)

      const cacheKeys = mockR2Bucket.keys()
      expect(cacheKeys).toContain('1472197491844026370.json') // Default MoonwellDeFi userid
    })

    it('should handle custom userid parameter', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const customUserId = '1234567890'
      const request = new Request(`https://example.com?userid=${customUserId}`)
      
      // Mock the fetch to return a response for the custom user
      mockFetch.mockImplementationOnce(async () => {
        return new Response(JSON.stringify({
          data: [],
          includes: { users: [] },
          meta: { result_count: 0, newest_id: '', oldest_id: '' }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })

      await worker.fetch(request, env)

      const cacheKeys = mockR2Bucket.keys()
      expect(cacheKeys).toContain(`${customUserId}.json`)
    })
  })

  describe('Cache Isolation', () => {
    it('should not have cache collisions between different users', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const moonwellUserId = MOCK_USERS.MOONWELL_DEFI.id
      const mamoUserId = MOCK_USERS.MAMO_AGENT.id

      // Make request for MoonwellDeFi
      const moonwellRequest = new Request(`https://example.com?userid=${moonwellUserId}`)
      const moonwellResponse = await worker.fetch(moonwellRequest, env)
      const moonwellData = await moonwellResponse.json()

      // Make request for Mamo_agent
      const mamoRequest = new Request(`https://example.com?userid=${mamoUserId}`)
      const mamoResponse = await worker.fetch(mamoRequest, env)
      const mamoData = await mamoResponse.json()

      // Verify different data was returned
      expect(moonwellData.data[0].author_id).toBe(moonwellUserId)
      expect(mamoData.data[0].author_id).toBe(mamoUserId)
      expect(moonwellData.data[0].text).not.toBe(mamoData.data[0].text)

      // Verify both caches exist independently
      const moonwellCache = await mockR2Bucket.get(`${moonwellUserId}.json`)
      const mamoCache = await mockR2Bucket.get(`${mamoUserId}.json`)
      
      expect(moonwellCache).not.toBeNull()
      expect(mamoCache).not.toBeNull()
      expect(moonwellCache?.body).not.toBe(mamoCache?.body)
    })

    it('should maintain separate cache expiration times', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const moonwellUserId = MOCK_USERS.MOONWELL_DEFI.id
      const mamoUserId = MOCK_USERS.MAMO_AGENT.id

      // Set up cache with different timestamps
      const now = new Date()
      const staleTime = new Date(now.getTime() - 1000_000) // Over 15 minutes ago
      const freshTime = new Date(now.getTime() - 60_000)   // 1 minute ago

      // Pre-populate cache with different ages
      mockR2Bucket.setWithUploadTime(
        `${moonwellUserId}.json`,
        '{"data": "stale moonwell data"}',
        staleTime
      )
      mockR2Bucket.setWithUploadTime(
        `${mamoUserId}.json`,
        '{"data": "fresh mamo data"}',
        freshTime
      )

      // Request both users
      const moonwellRequest = new Request(`https://example.com?userid=${moonwellUserId}`)
      const mamoRequest = new Request(`https://example.com?userid=${mamoUserId}`)

      await worker.fetch(moonwellRequest, env) // Should trigger API call (stale cache)
      await worker.fetch(mamoRequest, env)     // Should use cache (fresh cache)

      // Verify that API was called once (for stale cache only)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      
      // Verify the API call was for the stale cache user
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(moonwellUserId),
        expect.any(Object)
      )
    })
  })

  describe('Cache Lifecycle', () => {
    it('should return cached data when cache is fresh', async () => {
      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const cachedData = { data: 'cached moonwell data' }

      // Pre-populate cache with fresh data
      const freshTime = new Date(Date.now() - 60_000) // 1 minute ago
      mockR2Bucket.setWithUploadTime(
        `${userId}.json`,
        JSON.stringify(cachedData),
        freshTime
      )

      const request = new Request(`https://example.com?userid=${userId}`)
      const response = await worker.fetch(request, env)
      const data = await response.json()

      expect(data).toEqual(cachedData)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should fetch new data when cache is stale', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const staleData = { data: 'stale data' }

      // Pre-populate cache with stale data
      const staleTime = new Date(Date.now() - 1000_000) // Over 15 minutes ago
      mockR2Bucket.setWithUploadTime(
        `${userId}.json`,
        JSON.stringify(staleData),
        staleTime
      )

      const request = new Request(`https://example.com?userid=${userId}`)
      const response = await worker.fetch(request, env)
      const data = await response.json()

      expect(data).not.toEqual(staleData)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(userId),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-bearer-token'
          })
        })
      )
    })

    it('should fetch new data when no cache exists', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}`)
      
      const response = await worker.fetch(request, env)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.data).toBeInstanceOf(Array)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // Verify data was cached
      const cachedObject = await mockR2Bucket.get(`${userId}.json`)
      expect(cachedObject).not.toBeNull()
      expect(cachedObject?.metadata.userid).toBe(userId)
    })
  })

  describe('Parameter Handling', () => {
    it('should handle max_results parameter', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const maxResults = 3
      const request = new Request(`https://example.com?userid=${userId}&max_results=${maxResults}`)

      await worker.fetch(request, env)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`max_results=${maxResults}`),
        expect.any(Object)
      )
    })

    it('should use default max_results when not provided', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}`)

      await worker.fetch(request, env)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('max_results=6'),
        expect.any(Object)
      )
    })

    it('should handle invalid max_results gracefully', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}&max_results=invalid`)

      await worker.fetch(request, env)

      // Should default to 6 when parseInt fails
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('max_results=6'),
        expect.any(Object)
      )
    })
  })

  describe('Error Handling', () => {
    it('should return stale cache on API error when available', async () => {
      mockFetch.mockImplementation(createFailingMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const staleData = { data: 'stale but valid data' }

      // Pre-populate cache with stale data
      const staleTime = new Date(Date.now() - 1000_000)
      mockR2Bucket.setWithUploadTime(
        `${userId}.json`,
        JSON.stringify(staleData),
        staleTime
      )

      const request = new Request(`https://example.com?userid=${userId}`)
      const response = await worker.fetch(request, env)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data).toEqual(staleData)
    })

    it('should return error when API fails and no cache available', async () => {
      mockFetch.mockImplementation(createFailingMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}`)

      const response = await worker.fetch(request, env)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error).toBe('Failed to fetch data and no cache available')
    })

    it('should reject non-GET requests', async () => {
      const request = new Request('https://example.com', { method: 'POST' })
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('GET')
    })
  })

  describe('CORS Headers', () => {
    it('should include CORS headers in successful responses', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const request = new Request('https://example.com')
      const response = await worker.fetch(request, env)

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,HEAD,POST,OPTIONS')
      expect(response.headers.get('content-type')).toBe('application/json')
    })

    it('should include CORS headers in cached responses', async () => {
      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const cachedData = { data: 'cached data' }

      // Pre-populate cache
      const freshTime = new Date(Date.now() - 60_000)
      mockR2Bucket.setWithUploadTime(
        `${userId}.json`,
        JSON.stringify(cachedData),
        freshTime
      )

      const request = new Request(`https://example.com?userid=${userId}`)
      const response = await worker.fetch(request, env)

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(response.headers.get('content-type')).toBe('application/json')
    })
  })
})