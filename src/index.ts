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

    const object = await env.MY_BUCKET.get('latest.json')

    if (
      (object === null) ||
      (object.uploaded.getTime() < (Date.now()) - 600_000)
    ) { // Cached object is not found or older than 10 minutes ago
      console.log('Cache miss, fetching new data...')
      let response: Response
      let twitterUrl: string

      const userid = url.searchParams.get('userid') || '1472197491844026370' // @MoonwellDeFi
      const max_results = parseInt(url.searchParams.get('max_results') || '5')
      twitterUrl = 'https://api.twitter.com/2/users/' +
        userid +
        '/liked_tweets?max_results=' +
        max_results +
        '&tweet.fields=created_at,entities,public_metrics&expansions=author_id&user.fields=profile_image_url,username'
      console.log('About to fetch: ', twitterUrl)
      response = await fetch(
        twitterUrl,
        {
          headers: {
            'content-type': 'application/json;charset=UTF-8',
            Authorization: `Bearer ${env.TWITTER_BEARER_TOKEN}`,
          },
        },
      )

      const data: Record<string, unknown> = await response.json()
      await env.MY_BUCKET.put('latest.json', JSON.stringify(data), {
        metadata: {
          'Content-Type': 'application/json',
        },
      });
      return respond(data)
    } else {
      console.log('Cache hit, returning cached data...')
      return new Response(object.body, {
        headers: { 'content-type': 'application/json', ...corsHeaders },
        status: 200,
      })
    }
  }
}
