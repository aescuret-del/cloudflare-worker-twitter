const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Max-Age': '86400',
}

const respond = (response: Record<string, unknown>, code?: number) =>
  new Response(JSON.stringify(response), {
    headers: { 'content-type': 'application/json', ...corsHeaders },
    status: code,
  })

export default {
  async fetch(
    request: Request,
    env: Record<string, any>
  ) {
    const url = new URL(request.url)

    if (request.method !== 'GET') {
      console.log("Method Not Allowed");
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          Allow: 'GET',
        },
      });
    }

    // Parse parameters early to generate user-specific cache key
    // Default to MoonwellDeFi's Twitter account if no userid is provided
    // Mamo_agent's Twitter ID: 1883305846995845120
    const userid = url.searchParams.get('userid') || '1472197491844026370' // @MoonwellDeFi
    const max_results_param = url.searchParams.get('max_results') || '6'
    const max_results = parseInt(max_results_param) || 6 // Default to 6 if parseInt fails
    
    // Generate user-specific cache key to prevent cache collisions
    const cacheKey = `${userid}.json`
    console.log(`Using cache key: ${cacheKey}`)

    let object = null
    try {
      object = await env.MY_BUCKET.get(cacheKey)
    } catch (e) {
      console.log('Error reading from R2 cache:', e)
      // Continue without cache on R2 errors
    }

    if (
      (object === null) ||
      (object.uploaded.getTime() < (Date.now()) - 901_000)
    ) { // Cached object is not found or older than 15 minutes ago
      console.log(`Cache miss for userid ${userid}, fetching new data...`)
      let response: Response
      let twitterUrl: string

      twitterUrl = 'https://api.twitter.com/2/users/' +
        userid +
        '/tweets?max_results=' +
        max_results +
        '&tweet.fields=created_at,entities,public_metrics&expansions=author_id&user.fields=profile_image_url,username'
      console.log('About to fetch: ', twitterUrl)
      try {
        response = await fetch(
          twitterUrl,
          {
            headers: {
              'content-type': 'application/json;charset=UTF-8',
              Authorization: `Bearer ${env.TWITTER_BEARER_TOKEN}`,
            },
          },
        )
        
        // Check for HTTP error status codes (like 429 rate limiting, 401 auth errors, etc.)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }
      } catch (e) {
        console.log('Error fetching from Twitter: ', e)
        // If we have stale cached data, return it during error conditions
        if (object !== null) {
          console.log('Returning stale cached data due to API error')
          return new Response(object.body, {
            headers: { 'content-type': 'application/json', ...corsHeaders },
            status: 200,
          })
        }
        // No cached data available, return error
        return respond({ error: 'Failed to fetch data and no cache available' }, 500)
      }

      let data: Record<string, unknown>
      try {
        data = await response.json()
      } catch (e) {
        console.log('Error parsing JSON response:', e)
        // If we have stale cached data, return it during JSON parse errors
        if (object !== null) {
          console.log('Returning stale cached data due to JSON parse error')
          return new Response(object.body, {
            headers: { 'content-type': 'application/json', ...corsHeaders },
            status: 200,
          })
        }
        // No cached data available, return error
        return respond({ error: 'Failed to parse response and no cache available' }, 500)
      }
      
      // Store data with user-specific cache key
      try {
        await env.MY_BUCKET.put(cacheKey, JSON.stringify(data), {
          metadata: {
            'Content-Type': 'application/json',
            'userid': userid,
          },
        });
        console.log(`Data cached for userid ${userid}`)
      } catch (e) {
        console.log('Error storing to R2 cache:', e)
        // Continue without caching on R2 errors
      }
      return respond(data)
    } else {
      console.log(`Cache hit for userid ${userid}, returning cached data...`)
      return new Response(object.body, {
        headers: { 'content-type': 'application/json', ...corsHeaders },
        status: 200,
      })
    }
  }
}
