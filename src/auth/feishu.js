const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

let cachedAppToken = null;

/**
 * Get or refresh Feishu app access token
 */
async function getAppAccessToken() {
  if (cachedAppToken && Date.now() < cachedAppToken.expiresAt) {
    return cachedAppToken.token;
  }

  const res = await fetch(`${FEISHU_BASE}/auth/v3/app_access_token/internal/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }),
  });

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Failed to get app_access_token: ${data.msg}`);
  }

  cachedAppToken = {
    token: data.app_access_token,
    expiresAt: Date.now() + (data.expire - 60) * 1000,
  };
  return data.app_access_token;
}

/**
 * Build Feishu authorize URL
 */
function buildAuthorizeUrl(redirectUri, state) {
  const params = new URLSearchParams({
    app_id: process.env.FEISHU_APP_ID,
    redirect_uri: redirectUri,
    state,
  });
  return `${FEISHU_BASE}/authen/v1/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for user info
 */
async function exchangeCodeForUser(code) {
  const appToken = await getAppAccessToken();

  // Get access token
  const tokenRes = await fetch(`${FEISHU_BASE}/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${appToken}`,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
    }),
  });

  const tokenData = await tokenRes.json();
  if (tokenData.code !== 0) {
    throw new Error(`Failed to exchange code: ${tokenData.msg}`);
  }

  // Get user info
  const userRes = await fetch(`${FEISHU_BASE}/authen/v1/user_info`, {
    headers: {
      Authorization: `Bearer ${tokenData.data.access_token}`,
    },
  });

  const userData = await userRes.json();
  if (userData.code !== 0) {
    throw new Error(`Failed to get user info: ${userData.msg}`);
  }

  return {
    openId: userData.data.open_id,
    unionId: userData.data.union_id,
    name: userData.data.name,
    avatarUrl: userData.data.avatar_url,
    tenantKey: userData.data.tenant_key,
  };
}

module.exports = {
  getAppAccessToken,
  buildAuthorizeUrl,
  exchangeCodeForUser,
};
