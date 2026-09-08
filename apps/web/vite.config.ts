import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// Development-only evidence recorder for the isolated feasibility spike.
function renderEvidence(): Plugin {
  return { name: 'render-evidence', configureServer(server) {
    server.middlewares.use('/__render-evidence', async (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 65000000) throw new Error('Capture too large'); }
        const { name, image, video, samples, context } = JSON.parse(body);
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name)) throw new Error('Invalid capture name');
        const dir = fileURLToPath(new URL('../../.evidence.local/', import.meta.url));
        await mkdir(dir, { recursive: true });
        if (image) {
          if (!image.startsWith('data:image/png;base64,')) throw new Error('Expected PNG');
          await writeFile(`${dir}/${name}.png`, Buffer.from(image.slice(22), 'base64'));
        }
        if (video) {
          if (!video.startsWith('data:video/webm;base64,')) throw new Error('Expected WebM');
          await writeFile(`${dir}/${name}.webm`, Buffer.from(video.slice('data:video/webm;base64,'.length), 'base64'));
        }
        await writeFile(`${dir}/${name}.json`, JSON.stringify({ context, samples }, null, 2));
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ saved: name }));
      } catch (error) { res.statusCode = 400; res.end(String(error)); }
    });
  } };
}
export default defineConfig({ plugins: [react(), renderEvidence()] });
