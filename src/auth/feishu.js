const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

let cachedAppToken = null;

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
    throw new Error(`failed to get Feishu app token: ${data.msg || data.code}`);
  }

  cachedAppToken = {
    token: data.app_access_token,
    expiresAt: Date.now() + Math.max(0, (data.expire || 0) - 60) * 1000,
  };
  return cachedAppToken.token;
}

function buildAuthorizeUrl(redirectUri, state) {
  const params = new URLSearchParams({
    app_id: process.env.FEISHU_APP_ID,
    redirect_uri: redirectUri,
    state,
  });
  return `${FEISHU_BASE}/authen/v1/authorize?${params.toString()}`;
}

async function exchangeCodeForUser(code) {
  const appToken = await getAppAccessToken();

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
    throw new Error(`failed to exchange Feishu code: ${tokenData.msg || tokenData.code}`);
  }

  const userRes = await fetch(`${FEISHU_BASE}/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${tokenData.data.access_token}` },
  });

  const userData = await userRes.json();
  if (userData.code !== 0) {
    throw new Error(`failed to get Feishu user info: ${userData.msg || userData.code}`);
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
  buildAuthorizeUrl,
  exchangeCodeForUser,
  getAppAccessToken,
};
