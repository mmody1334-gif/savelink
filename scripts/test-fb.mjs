async function testDomains() {
  const domains = [
    'https://www.facebook.com/zuck',
    'https://m.facebook.com/zuck',
    'https://mbasic.facebook.com/zuck',
  ];

  for (const url of domains) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      }
    });
    console.log(url, '-> Status:', res.status);
    const text = await res.text();
    const ogTitle = text.match(/property="og:title" content="([^"]+)"/)?.[1] || text.match(/<title>([^<]+)<\/title>/)?.[1];
    const ogImage = text.match(/property="og:image" content="([^"]+)"/)?.[1];
    console.log('   Title:', ogTitle);
    console.log('   Image:', ogImage ? ogImage.slice(0, 60) + '...' : undefined);
  }
}
testDomains();
