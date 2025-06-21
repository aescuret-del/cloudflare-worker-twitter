import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockR2Bucket } from './mocks/r2-bucket.mock'
import { createFailingMockFetch, createRateLimitedMockFetch, MOCK_USERS } from './mocks/twitter-api.mock'
import worker from '../src/index'

// Mock the global fetch function
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('Error Handling Tests', () => {
  let env: any

  beforeEach(() => {
    mockR2Bucket.clear()
    mockFetch.mockReset()
    
    env = {
      MY_BUCKET: mockR2Bucket,
      TWITTER_BEARER_TOKEN: 'test-bearer-token'
    }
  })

  describe('Network Error Scenarios', () => {
    it('should return stale cache when API fails and cache is available', async () => {
      mockFetch.mockImplementation(createFailingMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const staleData = { data: 'stale but usable data' }

      // Pre-populate with stale cache
      const staleTime = new Date(Date.now() - 2000_000) // Very old
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

    it('should return error when API fails and no cache exists', async () => {
      mockFetch.mockImplementation(createFailingMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}`)

      const response = await worker.fetch(request, env)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error).toBe('Failed to fetch data and no cache available')
    })

    it('should handle rate limiting gracefully', async () => {
      mockFetch.mockImplementation(createRateLimitedMockFetch())

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const staleData = { data: 'fallback data' }

      // Pre-populate with stale cache
      const staleTime = new Date(Date.now() - 2000_000)
      mockR2Bucket.setWithUploadTime(
        `${userId}.json`,
        JSON.stringify(staleData),
        staleTime
      )

      const request = new Request(`https://example.com?userid=${userId}`)
      const response = await worker.fetch(request, env)
      const data = await response.json()

      // Should return stale cache when rate limited
      expect(response.status).toBe(200)
      expect(data).toEqual(staleData)
    })

    it('should handle timeout scenarios', async () => {
      // Mock fetch that times out
      mockFetch.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        throw new Error('Request timeout')
      })

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const backupData = { data: 'backup data from cache' }

      // Pre-populate cache
      const oldTime = new Date(Date.now() - 2000_000)
      mockR2Bucket.setWithUploadTime(
        `${userId}.json`,
        JSON.stringify(backupData),
        oldTime
      )

      const request = new Request(`https://example.com?userid=${userId}`)
      const response = await worker.fetch(request, env)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data).toEqual(backupData)
    })
  })

  describe('Authentication Errors', () => {
    it('should handle missing bearer token', async () => {
      // Remove bearer token from environment
      env.TWITTER_BEARER_TOKEN = undefined

      mockFetch.mockImplementation(async () => {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
      })

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}`)

      const response = await worker.fetch(request, env)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error).toBe('Failed to fetch data and no cache available')
    })

    it('should handle invalid bearer token', async () => {
      env.TWITTER_BEARER_TOKEN = 'invalid-token'

      mockFetch.mockImplementation(async () => {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
      })

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const staleData = { data: 'cached data for auth failure' }

      // Pre-populate cache
      const staleTime = new Date(Date.now() - 2000_000)
      mockR2Bucket.setWithUploadTime(
        `${userId}.json`,
        JSON.stringify(staleData),
        staleTime
      )

      const request = new Request(`https://example.com?userid=${userId}`)
      const response = await worker.fetch(request, env)
      const data = await response.json()

      // Should fall back to stale cache
      expect(response.status).toBe(200)
      expect(data).toEqual(staleData)
    })
  })

  describe('R2 Bucket Errors', () => {
    it('should handle R2 bucket read failures', async () => {
      // Mock R2 bucket get method to fail
      const originalGet = mockR2Bucket.get
      const getSpy = vi.fn().mockRejectedValue(new Error('R2 read failure'))
      mockR2Bucket.get = getSpy

      mockFetch.mockImplementation(async () => {
        return new Response(JSON.stringify({
          data: [{ id: '1', text: 'Fresh data from API' }],
          includes: { users: [MOCK_USERS.MOONWELL_DEFI] },
          meta: { result_count: 1, newest_id: '1', oldest_id: '1' }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}`)

      const response = await worker.fetch(request, env)
      const data = await response.json()

      // Should still work by fetching from API
      expect(response.status).toBe(200)
      expect(data.data).toHaveLength(1)

      // Verify the get was attempted
      expect(getSpy).toHaveBeenCalled()

      // Restore original method
      mockR2Bucket.get = originalGet
    })

    it('should handle R2 bucket write failures', async () => {
      // Mock R2 bucket put method to fail
      const originalPut = mockR2Bucket.put
      const putSpy = vi.fn().mockRejectedValue(new Error('R2 write failure'))
      mockR2Bucket.put = putSpy

      mockFetch.mockImplementation(async () => {
        return new Response(JSON.stringify({
          data: [{ id: '1', text: 'API data' }],
          includes: { users: [MOCK_USERS.MOONWELL_DEFI] },
          meta: { result_count: 1, newest_id: '1', oldest_id: '1' }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}`)

      const response = await worker.fetch(request, env)
      const data = await response.json()

      // Should still return data even if caching fails
      expect(response.status).toBe(200)
      expect(data.data).toHaveLength(1)

      // Verify the put was attempted
      expect(putSpy).toHaveBeenCalled()

      // Restore original method
      mockR2Bucket.put = originalPut
    })
  })

  describe('Twitter API Response Errors', () => {
    it('should handle malformed JSON responses', async () => {
      mockFetch.mockImplementation(async () => {
        return new Response('Invalid JSON{{{', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const fallbackData = { data: 'fallback data' }

      // Pre-populate cache
      const staleTime = new Date(Date.now() - 2000_000)
      mockR2Bucket.setWithUploadTime(
        `${userId}.json`,
        JSON.stringify(fallbackData),
        staleTime
      )

      const request = new Request(`https://example.com?userid=${userId}`)
      const response = await worker.fetch(request, env)
      const data = await response.json()

      // Should fall back to cache on JSON parse error
      expect(response.status).toBe(200)
      expect(data).toEqual(fallbackData)
    })

    it('should handle empty API responses', async () => {
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

      const userId = MOCK_USERS.MOONWELL_DEFI.id
      const request = new Request(`https://example.com?userid=${userId}`)

      const response = await worker.fetch(request, env)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.data).toEqual([])
      expect(data.meta.result_count).toBe(0)
    })

    it('should handle user not found errors', async () => {
      mockFetch.mockImplementation(async () => {
        return new Response(JSON.stringify({
          error: 'User not found'
        }), {
          status: 404,
          headers: { 'content-type': 'application/json' }
        })
      })

      const userId = '9999999999999999999' // Non-existent user
      const request = new Request(`https://example.com?userid=${userId}`)

      const response = await worker.fetch(request, env)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error).toBe('Failed to fetch data and no cache available')
    })
  })

  describe('HTTP Method Validation', () => {
    it('should reject POST requests', async () => {
      const request = new Request('https://example.com', { method: 'POST' })
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('GET')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should reject PUT requests', async () => {
      const request = new Request('https://example.com', { method: 'PUT' })
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('GET')
    })

    it('should reject DELETE requests', async () => {
      const request = new Request('https://example.com', { method: 'DELETE' })
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('GET')
    })

    it('should accept GET requests', async () => {
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

      const request = new Request('https://example.com', { method: 'GET' })
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(200)
    })
  })

  describe('Edge Cases', () => {
    it('should handle extremely long userids', async () => {
      const longUserId = '1'.repeat(100) // Very long userid
      
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

      const request = new Request(`https://example.com?userid=${longUserId}`)
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(200)
      expect(mockR2Bucket.keys()).toContain(`${longUserId}.json`)
    })

    it('should handle special characters in userid gracefully', async () => {
      // Note: In real Twitter, userids are numeric, but we should handle edge cases
      const specialUserId = '123-456_789'
      
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

      const request = new Request(`https://example.com?userid=${encodeURIComponent(specialUserId)}`)
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(200)
    })

    it('should handle missing environment variables', async () => {
      const incompleteEnv = {} // Missing both TWITTER_BEARER_TOKEN and MY_BUCKET

      const request = new Request('https://example.com')
      
      // Worker should gracefully handle missing environment variables
      const response = await worker.fetch(request, incompleteEnv)
      expect(response.status).toBe(500)
      
      const data = await response.json()
      expect(data.error).toBe('Failed to fetch data and no cache available')
    })
  })
})