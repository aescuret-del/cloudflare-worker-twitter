import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mockR2Bucket } from './mocks/r2-bucket.mock'
import { createMockFetch, MOCK_USERS } from './mocks/twitter-api.mock'
import worker from '../src/index'

// Mock the global fetch function
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('Cache-Specific Logic Tests', () => {
  let env: any

  beforeEach(() => {
    mockR2Bucket.clear()
    mockFetch.mockReset()
    
    env = {
      MY_BUCKET: mockR2Bucket,
      TWITTER_BEARER_TOKEN: 'test-bearer-token'
    }
  })

  describe('Cache Key Generation', () => {
    it('should generate consistent cache keys for the same userid', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request1 = new Request(`https://example.com?userid=${userId}`)
      const request2 = new Request(`https://example.com?userid=${userId}&max_results=10`)

      await worker.fetch(request1, env)
      await worker.fetch(request2, env)

      // Should use the same cache key regardless of other parameters
      const cacheKeys = mockR2Bucket.keys()
      expect(cacheKeys).toContain(`${userId}.json`)
      expect(cacheKeys).toHaveLength(1) // Only one cache entry
      expect(mockFetch).toHaveBeenCalledTimes(1) // Only one API call due to cache hit
    })

    it('should handle edge case userids correctly', async () => {
      mockFetch.mockImplementation(async () => {
        return new Response(JSON.stringify({
          data: [],
          includes: { users: [] },
          meta: { result_count: 0, newest_id: '', oldest_id: '' }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })

      const edgeCases = [
        '0',
        '9999999999999999999',  // Very long userid
        '1',                    // Single digit
      ]

      for (const userId of edgeCases) {
        const request = new Request(`https://example.com?userid=${userId}`)
        await worker.fetch(request, env)
        
        expect(mockR2Bucket.keys()).toContain(`${userId}.json`)
      }

      expect(mockR2Bucket.keys()).toHaveLength(edgeCases.length)
    })
  })

  describe('Cache Expiration Logic', () => {
    it('should respect 901 second cache timeout', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const now = new Date()

      // Test slightly beyond the boundary to ensure it's stale
      const staleTime = new Date(now.getTime() - 902_000) // 902 seconds ago (beyond 901)
      mockR2Bucket.setWithUploadTime(
        `${userId}.json`,
        '{"data": "boundary data"}',
        staleTime
      )

      const request = new Request(`https://example.com?userid=${userId}`)
      await worker.fetch(request, env)

      // Should trigger API call since cache is stale
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should use cache when within 901 second window', async () => {
      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const cachedData = { data: 'fresh cached data' }
      const now = new Date()

      // Cache data that's just under the 901 second limit
      const withinLimitTime = new Date(now.getTime() - 900_000) // 900 seconds ago
      mockR2Bucket.setWithUploadTime(
        `${userId}.json`,
        JSON.stringify(cachedData),
        withinLimitTime
      )

      const request = new Request(`https://example.com?userid=${userId}`)
      const response = await worker.fetch(request, env)
      const data = await response.json()

      expect(data).toEqual(cachedData)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should handle future timestamps gracefully', async () => {
      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const cachedData = { data: 'future data' }
      const now = new Date()

      // Cache data with future timestamp (edge case)
      const futureTime = new Date(now.getTime() + 60_000) // 1 minute in future
      mockR2Bucket.setWithUploadTime(
        `${userId}.json`,
        JSON.stringify(cachedData),
        futureTime
      )

      const request = new Request(`https://example.com?userid=${userId}`)
      const response = await worker.fetch(request, env)
      const data = await response.json()

      // Should use cache (future timestamp should be treated as fresh)
      expect(data).toEqual(cachedData)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('Cache Storage Metadata', () => {
    it('should store userid in cache metadata', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}`)

      await worker.fetch(request, env)

      const cachedObject = await mockR2Bucket.get(`${userId}.json`)
      expect(cachedObject).not.toBeNull()
      expect(cachedObject?.metadata.userid).toBe(userId)
      expect(cachedObject?.metadata['Content-Type']).toBe('application/json')
    })

    it('should handle cache storage failures gracefully', async () => {
      mockFetch.mockImplementation(createMockFetch())

      // Mock R2 bucket put method to fail
      const originalPut = mockR2Bucket.put
      const putSpy = vi.fn().mockRejectedValue(new Error('Storage failure'))
      mockR2Bucket.put = putSpy

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}`)

      // Should still return response even if caching fails
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(200)

      // Verify the put was attempted
      expect(putSpy).toHaveBeenCalled()

      // Restore original method
      mockR2Bucket.put = originalPut
    })
  })

  describe('Concurrent Cache Access', () => {
    it('should handle concurrent requests for same userid', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      
      // Make multiple concurrent requests
      const promises = [
        worker.fetch(new Request(`https://example.com?userid=${userId}`), env),
        worker.fetch(new Request(`https://example.com?userid=${userId}`), env),
        worker.fetch(new Request(`https://example.com?userid=${userId}`), env)
      ]

      const responses = await Promise.all(promises)

      // All should succeed
      for (const response of responses) {
        expect(response.status).toBe(200)
      }

      // Should have made API calls (cache misses for concurrent requests are expected)
      expect(mockFetch).toHaveBeenCalled()
      
      // Should have cached the result
      const cachedObject = await mockR2Bucket.get(`${userId}.json`)
      expect(cachedObject).not.toBeNull()
    })

    it('should handle concurrent requests for different userids', async () => {
      // Mock fetch to handle any userid
      mockFetch.mockImplementation(async (url: string) => {
        const urlObj = new URL(url)
        const pathParts = urlObj.pathname.split('/')
        const userId = pathParts[3]
        
        return new Response(JSON.stringify({
          data: [{
            id: '1',
            text: `Test tweet for user ${userId}`,
            created_at: '2024-01-15T10:00:00.000Z',
            author_id: userId,
            public_metrics: { retweet_count: 1, like_count: 1, reply_count: 1, quote_count: 1 }
          }],
          includes: { users: [{ id: userId, username: `user${userId}`, profile_image_url: 'test.jpg' }] },
          meta: { result_count: 1, newest_id: '1', oldest_id: '1' }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })

      const userIds = [
        MOCK_USERS.MOONWELL_DEFI.id,
        MOCK_USERS.MAMO_AGENT.id,
        '1234567890'
      ]

      // Make concurrent requests for different users
      const promises = userIds.map(userId => {
        const request = new Request(`https://example.com?userid=${userId}`)
        return worker.fetch(request, env)
      })

      const responses = await Promise.all(promises)

      // All should succeed
      for (const response of responses) {
        expect(response.status).toBe(200)
      }

      // Should have separate cache entries
      const cacheKeys = mockR2Bucket.keys()
      for (const userId of userIds) {
        expect(cacheKeys).toContain(`${userId}.json`)
      }
      expect(cacheKeys).toHaveLength(userIds.length)
    })
  })

  describe('Cache Hit/Miss Logging', () => {
    let consoleSpy: any

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleSpy.mockRestore()
    })

    it('should log cache miss with userid', async () => {
      mockFetch.mockImplementation(createMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}`)

      await worker.fetch(request, env)

      expect(consoleSpy).toHaveBeenCalledWith(`Using cache key: ${userId}.json`)
      expect(consoleSpy).toHaveBeenCalledWith(`Cache miss for userid ${userId}, fetching new data...`)
      // Note: The caching may or may not succeed depending on R2 mock state
    })

    it('should log cache hit with userid', async () => {
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
      await worker.fetch(request, env)

      expect(consoleSpy).toHaveBeenCalledWith(`Using cache key: ${userId}.json`)
      expect(consoleSpy).toHaveBeenCalledWith(`Cache hit for userid ${userId}, returning cached data...`)
    })
  })
})