// Hooks file used by auth-edge-cases tests to capture reset tokens
const tokens: string[] = [];

export const onPasswordReset = (email: string, token: string) => {
  tokens.push(token);
};

// Expose captured tokens via a global so the test can read them
(globalThis as any).__test_reset_tokens = tokens;
