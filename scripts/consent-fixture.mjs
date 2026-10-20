import http from 'node:http';
let saved = null;
const server = http.createServer((req, res) => {
  if (req.url === '/state') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(saved));
    return;
  }
  if (req.url.startsWith('/save?')) {
    const q = new URL(req.url, 'http://localhost').searchParams;
    saved = {
      analytics: q.get('analytics') === 'true',
      advertising: q.get('advertising') === 'true',
    };
    res.end('saved');
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<!doctype html><title>Consent regression fixture</title><style>body{font:20px sans-serif;padding:30px;background:#eef3f8;color:#13213a}button{padding:12px;margin:8px}#banner{border:2px solid #456;padding:20px;background:white}#preferences{display:none}</style><h1>Browser regression fixture</h1><p>Test card: BLUE TRIANGLE 42</p><div id="banner" role="dialog" aria-label="Cookie preferences"><h2>Cookie choices</h2><p>Necessary cookies keep this test site working. Optional analytics and advertising cookies are available.</p><button id="accept">Accept all</button><button id="customize">Preferences</button><div id="preferences"><label><input type="checkbox" id="necessary" checked disabled>Necessary cookies</label><br><label><input type="checkbox" id="analytics" checked>Analytics cookies</label><br><label><input type="checkbox" id="advertising" checked>Advertising cookies</label><br><button id="save">Save choices</button></div></div><p id="result"></p><script>const banner=document.querySelector('#banner');const finish=async(a,b)=>{await fetch('/save?analytics='+a+'&advertising='+b);localStorage.setItem('consent',JSON.stringify({analytics:a,advertising:b}));banner.remove();document.querySelector('#result').textContent='Choices saved: analytics='+a+', advertising='+b;};document.querySelector('#customize').onclick=()=>document.querySelector('#preferences').style.display='block';document.querySelector('#accept').onclick=()=>finish(true,true);document.querySelector('#save').onclick=()=>finish(document.querySelector('#analytics').checked,document.querySelector('#advertising').checked);if(localStorage.getItem('consent'))banner.remove();</script>`,
  );
});
server.listen(0, '127.0.0.1', () =>
  console.log(`Consent fixture: http://127.0.0.1:${server.address().port}`),
);
