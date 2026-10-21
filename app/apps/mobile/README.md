# Family Office — mobile (Expo)

Companion app sharing the API contract with the web app. Screens: Login, Dashboard, Holdings, Property (with rent schedule), Tasks (biometric step-up before completing), More.

```bash
pnpm install
cp .env.example .env   # or set extra.apiUrl in app.json
pnpm start             # Expo dev server; press i / a, or scan with Expo Go
```
For a device on the same network as a local API, set `extra.apiUrl` to `http://<your-lan-ip>:4000/api/v1`. Production builds use EAS (`eas build`) and point at `https://api.<domain>/api/v1`.
Tokens are stored in SecureStore; the family id in AsyncStorage; a 401 triggers a silent refresh.
