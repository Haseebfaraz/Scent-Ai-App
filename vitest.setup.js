import "dotenv/config";

// app/utils/previewUrl.server.js requires a real public app URL and throws without one — this
// repo's own .env deliberately doesn't set one locally (only Render's real environment does), so
// tests need their own stand-in, matching the same placeholder already used for local dev/browser
// verification of this feature.
process.env.SHOPIFY_APP_URL ||= "https://scent-ai-app.onrender.com";
