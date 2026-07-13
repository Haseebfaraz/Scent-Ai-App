// import { authenticate } from "../shopify.server";

// export const loader = async ({ request }) => {
//   await authenticate.admin(request);

//   return null;
// };





import { authenticate, login } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  // If the user is specifically hitting the login path, handle it with shopify.login()
  if (url.pathname === "/auth/login") {
    return await login(request);
  }

  // For all other /auth/* setup requests, run normal admin authentication
  await authenticate.admin(request);

  return null;
};