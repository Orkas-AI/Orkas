/** One public callback for merchant-registered apps in every profile. Merchants register this
 * stable URL with their provider; changing account profile must not change that registration.
 * Only one-time authorization codes traverse this relay. */
export const LOCAL_API_REDIRECT_URI = 'https://orkas.ai/api/connectors/oauth/dcr-callback';
