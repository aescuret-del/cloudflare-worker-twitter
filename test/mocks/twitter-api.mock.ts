// Mock implementation of Twitter API responses for testing

export interface TwitterUser {
  id: string
  username: string
  profile_image_url: string
}

export interface TwitterTweet {
  id: string
  text: string
  created_at: string
  author_id: string
  public_metrics: {
    retweet_count: number
    like_count: number
    reply_count: number
    quote_count: number
  }
  entities?: {
    urls?: Array<{
      start: number
      end: number
      url: string
      expanded_url: string
      display_url: string
    }>
    hashtags?: Array<{
      start: number
      end: number
      tag: string
    }>
  }
}

export interface TwitterApiResponse {
  data: TwitterTweet[]
  includes: {
    users: TwitterUser[]
  }
  meta: {
    result_count: number
    newest_id: string
    oldest_id: string
  }
}

// Mock data for different users
export const MOCK_USERS = {
  MOONWELL_DEFI: {
    id: '1472197491844026370',
    username: 'MoonwellDeFi',
    profile_image_url: 'https://pbs.twimg.com/profile_images/1472197491844026370/test.jpg'
  },
  MAMO_AGENT: {
    id: '1883305846995845120',
    username: 'Mamo_agent',
    profile_image_url: 'https://pbs.twimg.com/profile_images/1883305846995845120/test.jpg'
  }
}

export const MOCK_TWEETS = {
  [MOCK_USERS.MOONWELL_DEFI.id]: [
    {
      id: '1001',
      text: 'Exciting updates coming to Moonwell protocol! 🌙',
      created_at: '2024-01-15T10:00:00.000Z',
      author_id: MOCK_USERS.MOONWELL_DEFI.id,
      public_metrics: {
        retweet_count: 25,
        like_count: 150,
        reply_count: 12,
        quote_count: 5
      },
      entities: {
        hashtags: [{ start: 50, end: 59, tag: 'DeFi' }]
      }
    },
    {
      id: '1002',
      text: 'New governance proposal is live! Check it out and participate.',
      created_at: '2024-01-14T15:30:00.000Z',
      author_id: MOCK_USERS.MOONWELL_DEFI.id,
      public_metrics: {
        retweet_count: 18,
        like_count: 89,
        reply_count: 8,
        quote_count: 3
      }
    }
  ],
  [MOCK_USERS.MAMO_AGENT.id]: [
    {
      id: '2001',
      text: 'AI agent updates and improvements rolling out! 🤖',
      created_at: '2024-01-15T12:00:00.000Z',
      author_id: MOCK_USERS.MAMO_AGENT.id,
      public_metrics: {
        retweet_count: 42,
        like_count: 234,
        reply_count: 18,
        quote_count: 7
      },
      entities: {
        hashtags: [{ start: 45, end: 48, tag: 'AI' }]
      }
    },
    {
      id: '2002',
      text: 'Working on some interesting new features for the community.',
      created_at: '2024-01-14T09:15:00.000Z',
      author_id: MOCK_USERS.MAMO_AGENT.id,
      public_metrics: {
        retweet_count: 15,
        like_count: 67,
        reply_count: 9,
        quote_count: 2
      }
    }
  ]
}

export function createMockTwitterResponse(userId: string, maxResults: number = 6): TwitterApiResponse {
  const user = Object.values(MOCK_USERS).find(u => u.id === userId)
  const tweets = MOCK_TWEETS[userId] || []
  
  if (!user) {
    throw new Error(`Mock user not found for ID: ${userId}`)
  }

  const limitedTweets = tweets.slice(0, maxResults)

  return {
    data: limitedTweets,
    includes: {
      users: [user]
    },
    meta: {
      result_count: limitedTweets.length,
      newest_id: limitedTweets[0]?.id || '',
      oldest_id: limitedTweets[limitedTweets.length - 1]?.id || ''
    }
  }
}

// Mock fetch function that simulates Twitter API
export function createMockFetch() {
  return async (url: string, options?: RequestInit): Promise<Response> => {
    // Parse the URL to extract userid and max_results
    const urlObj = new URL(url)
    const pathParts = urlObj.pathname.split('/')
    const userId = pathParts[3] // Extract userid from /2/users/{userid}/tweets
    const maxResults = parseInt(urlObj.searchParams.get('max_results') || '6')

    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 10))

    // Check for authorization header
    const authHeader = options?.headers?.['Authorization'] || options?.headers?.['authorization']
    if (!authHeader || !authHeader.includes('Bearer')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }

    try {
      const mockResponse = createMockTwitterResponse(userId, maxResults)
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    } catch (error) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })
    }
  }
}

// Mock fetch that simulates network errors
export function createFailingMockFetch() {
  return async (): Promise<Response> => {
    throw new Error('Network error')
  }
}

// Mock fetch that simulates rate limiting
export function createRateLimitedMockFetch() {
  return async (): Promise<Response> => {
    return new Response(JSON.stringify({ 
      error: 'Rate limit exceeded',
      detail: 'Too Many Requests' 
    }), {
      status: 429,
      headers: { 'content-type': 'application/json' }
    })
  }
}