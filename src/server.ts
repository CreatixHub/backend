// Placeholder so "npm run dev" works from minute one.
// Step 9 of the guide replaces this file with the real server.
import express from 'express';

const app = express();
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok (placeholder - replace in step 9)' });
});
app.listen(5000, () => console.log('placeholder API on http://localhost:5000/api/health'));
