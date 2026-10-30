`localhost.key` / `localhost.crt` are a throwaway self-signed certificate for `localhost`, used only by `test/v16.test.mjs` to run a local HTTPS server
behind a local test proxy. The key protects nothing: it was generated for the tests and is not used anywhere else.
