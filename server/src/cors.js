// Browsers block a page from reading responses from another origin unless the API
// allows it. In dev, Vite's proxy makes the client and API one origin; in production
// they are separate domains, so the API allows exactly one: the client's.
//
// This is not authentication (the JWT is). It stops other websites from calling the
// API from a visitor's browser.
export function cors(allowedOrigin) {
  return (req, res, next) => {
    res.vary('Origin');
    const origin = req.get('Origin');
    if (allowedOrigin && origin === allowedOrigin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
      res.set('Access-Control-Max-Age', '600');
    }
    // Preflight: the browser asks before sending the real request. Without the headers
    // above (a different origin), the browser refuses to send it.
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}
