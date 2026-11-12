// Automatically unblock paywalls using Bypass Paywalls Clean techniques
(function() {
  const clearStorage = () => {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
      console.log('[Anexar Web Clipper] Cleared storage keys to bypass paywall.');
    } catch (e) {
      // Ignore
    }
  };

  // Run immediately at document start
  clearStorage();

  // Run again when DOM is loaded
  document.addEventListener('DOMContentLoaded', () => {
    clearStorage();
    
    // Clear cookies via client-side document.cookie if writable
    try {
      const cookies = document.cookie.split(";");
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i];
        const eqPos = cookie.indexOf("=");
        const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
        document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=" + window.location.hostname;
        document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=." + window.location.hostname.split('.').slice(-2).join('.');
      }
    } catch (e) {}

    // Target: asia.nikkei.com
    if (window.location.hostname.includes('nikkei.com')) {
      const paywall = document.querySelector('div#paywall-offer');
      const articlePreview = document.querySelector('div#article-body-preview > div');
      const jsonScript = document.querySelector('script#__NEXT_DATA__');
      
      if (articlePreview && jsonScript) {
        try {
          const json = JSON.parse(jsonScript.textContent);
          // Look for full body text in Next.js page dataProps structure
          const bodyData = json?.props?.pageProps?.data?.body;
          if (bodyData) {
            // Reconstruct the full article container
            const container = document.createElement('div');
            container.innerHTML = bodyData;
            
            // Swap paywalled preview container with full unblocked content
            articlePreview.parentNode.replaceChild(container, articlePreview);
            
            // Remove the paywall overlay
            if (paywall) paywall.remove();
            console.log('[Anexar Web Clipper] Restored full Nikkei article from __NEXT_DATA__ successfully.');
          }
        } catch (err) {
          console.error('[Anexar Web Clipper] Error restoring Nikkei content:', err);
        }
      }
    }

    // Inject CSS to automatically hide paywall popups, frames, and restore scrollability
    try {
      const style = document.createElement('style');
      style.textContent = `
        /* Hide paywall popups, overlays, and lightboxes */
        .paywall-modal,
        [class*="paywall-"],
        [id*="paywall-"],
        .tp-modal,
        .tp-backdrop,
        #piano-lightbox,
        .piano-container,
        .piano-lightbox,
        .subscription-modal,
        .gate-container,
        .modal-open .modal-backdrop,
        div#pianoj_ribbon,
        div#paywall-offer {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
        }
        
        /* Force-enable scrollbar and restore body layout scrolling */
        html, body {
          overflow: auto !important;
          overflow-y: auto !important;
          position: static !important;
          height: auto !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
      console.log('[Anexar Web Clipper] Injected paywall element hiding rules.');
    } catch (e) {}
  });
})();
