const WORKBENCH_PATHS = new Set(['/', '/index.html', '/workbench', '/workbench.html']);
const CLASSIC_PATHS = new Set(['/classic']);

function frontendDocumentForPath(pathname) {
  if (WORKBENCH_PATHS.has(pathname)) return 'workbench.html';
  if (CLASSIC_PATHS.has(pathname)) return 'index.html';
  return null;
}

function normalizeBrowserBase(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  if (!normalized || normalized === '/') return '';
  return normalized.startsWith('/') && !normalized.startsWith('//') ? normalized : '';
}

function hydrateFrontendDocument(template, { browserBase = '' } = {}) {
  const base = normalizeBrowserBase(browserBase);
  return String(template)
    .replaceAll('__BASE_PATH__', base)
    .replaceAll('__ASSET_ROOT__', base);
}

function buildFrontendDocumentResponse(pathname, loadTemplate, options = {}) {
  const documentName = frontendDocumentForPath(pathname);
  if (!documentName) return null;
  return {
    documentName,
    cacheControl: 'no-store',
    body: hydrateFrontendDocument(loadTemplate(documentName), options),
  };
}

module.exports = {
  buildFrontendDocumentResponse,
  frontendDocumentForPath,
  hydrateFrontendDocument,
};
