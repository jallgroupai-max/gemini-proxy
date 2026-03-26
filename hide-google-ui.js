(() => {
  const SELECTORS = [
    'div.boqOnegoogleliteOgbOneGoogleBar',
    'mat-action-list.desktop-controls'
  ];

  function hideMatchingElements(root = document) {
    for (const selector of SELECTORS) {
      const elements = root.querySelectorAll(selector);
      for (const element of elements) {
        element.style.setProperty('display', 'none', 'important');
        element.style.setProperty('visibility', 'hidden', 'important');
        element.setAttribute('aria-hidden', 'true');
      }
    }
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          const element = node;
          if (typeof element.matches === 'function') {
            for (const selector of SELECTORS) {
              if (element.matches(selector)) {
                hideMatchingElements(element.parentNode || document);
                break;
              }
            }
          }

          if (typeof element.querySelector === 'function') {
            hideMatchingElements(element);
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    hideMatchingElements();
    startObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
