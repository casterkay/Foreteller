# Foreteller browser extension

1. Start the local panel service with `pnpm panel`.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select this `extension` directory.
4. Open a live YouTube watch page and configure Foreteller in the right sidebar.

The extension contains no API keys. It talks only to the Foreteller service bound to
`127.0.0.1:4318`.
