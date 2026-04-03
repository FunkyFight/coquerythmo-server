/**
 * Validates a password against the server's configured password.
 * @param {string} provided - The password from the client.
 * @returns {boolean}
 */
function validatePassword(provided) {
  const expected = process.env.PASSWORD || '';
  if (!expected) return true; // No password configured = open server
  return provided === expected;
}

module.exports = { validatePassword };
