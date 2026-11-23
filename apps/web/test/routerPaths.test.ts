/**
 * Moving between screens (react-router's navigate, which the command palette, notifications and a
 * guide's links use): a path written like another site's address, "//evil.example/jobs", is a
 * path in the app. In a browser, the other reading would leave the app for that site.
 */
import { createMemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

describe("a path that starts with two slashes", () => {
  it("stays in the app", async () => {
    const router = createMemoryRouter([{ path: "*", element: null }]);
    try {
      await router.navigate("//evil.example/jobs");
      expect(router.state.location.pathname).toBe("/evil.example/jobs");
    } finally {
      router.dispose();
    }
  });
});
