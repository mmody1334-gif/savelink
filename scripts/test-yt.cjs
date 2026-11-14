async function testInstances() {
  const instances = [
    'https://cobalt-api.kwiatekm.tokyo',
    'https://api.cobalt.server.garden',
    'https://cobalt.api.scub3d.com',
    'https://cobalt.synapticflare.net',
    'https://cobalt-backend.canine.tools',
    'https://api.cobalt.lol',
    'https://cobalt.tools/api',
    'https://cobalt.hyonsu.com',
    'https://api.savefrom.net',
    'https://api.v07.me',
    'https://cobalt.booo.top'
  ];

  for (const inst of instances) {
    try {
      const res = await fetch(inst, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        body: JSON.stringify({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          downloadMode: 'auto',
          videoQuality: '720'
        }),
        signal: AbortSignal.timeout(6000)
      });
      console.log(inst, '-> Status:', res.status);
      if (res.ok) {
        const json = await res.json();
        console.log('  SUCCESS:', json.status, json.url?.slice(0, 80));
      } else {
        const t = await res.text();
        console.log('  Fail:', t.slice(0, 100));
      }
    } catch (e) {
      console.log(inst, '-> Error:', e.message);
    }
  }
}

testInstances().catch(console.error);
