document.addEventListener('DOMContentLoaded', () => {
  const envSelect = document.getElementById('env');
  const clipBtn = document.getElementById('clip-btn');
  const statusBox = document.getElementById('status-box');

  // Load saved preference
  chrome.storage.local.get(['anexar_env'], (res) => {
    if (res.anexar_env) {
      envSelect.value = res.anexar_env;
    }
  });

  envSelect.addEventListener('change', () => {
    chrome.storage.local.set({ anexar_env: envSelect.value });
  });

  function showStatus(text, type) {
    statusBox.textContent = text;
    statusBox.className = `status ${type}`;
  }

  function getActiveTabHtml() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) {
          reject(new Error('No active browser tab found.'));
          return;
        }

        const activeTab = tabs[0];
        if (!activeTab.url || activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('edge://')) {
          reject(new Error('Cannot clip internal browser system pages.'));
          return;
        }

        chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => document.documentElement.outerHTML
        }, (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!results || results.length === 0) {
            reject(new Error('Failed to extract HTML from active tab.'));
          } else {
            resolve({
              url: activeTab.url,
              html: results[0].result
            });
          }
        });
      });
    });
  }

  clipBtn.addEventListener('click', async () => {
    clipBtn.disabled = true;
    showStatus('Extracting active page content...', 'info');
    
    // Insert loader icon
    clipBtn.innerHTML = '<span class="loader"></span> Processing...';

    try {
      const pageData = await getActiveTabHtml();
      showStatus('Uploading content & generating premium A4 PDF...', 'info');

      if (envSelect.value === 'hivemind') {
        showStatus('Ingesting and upgrading full text in HiveMind...', 'info');
        const res = await fetch('http://127.0.0.1:8788/api/clip', {
          method: 'POST',
          credentials: 'include',
          headers: { 
            'Content-Type': 'application/json',
            'X-Requested-With': 'hivemind'
          },
          body: JSON.stringify({ url: pageData.url, html: pageData.html })
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || 'HiveMind ingestion failed');
        showStatus(`Article successfully ingested into HiveMind! (${json.textLength} chars read${json.upgraded ? ' · story upgraded' : ''})`, 'success');
        clipBtn.disabled = false;
        clipBtn.innerHTML = '<span>Generate Premium PDF</span>';
        return;
      }

      const isLocal = envSelect.value === 'local';
      const targetApi = isLocal 
        ? 'http://localhost:3100/api/generate-article-pdf'
        : 'https://generatearticlepdf-mjsmlxvrgq-uc.a.run.app';

      console.log('Targeting API:', targetApi);

      // Call API (using synchronous mode to return PDF directly)
      const res = await fetch(targetApi, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: pageData.url,
          html: pageData.html,
          stream: false // Sync mode so we get the PDF download back directly
        })
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let errMsg = 'Failed to generate PDF.';
        try {
          const parsed = JSON.parse(errText);
          errMsg = parsed.error || errMsg;
        } catch(e) {}
        throw new Error(errMsg);
      }

      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      
      // Get filename from response header or default
      const contentDisposition = res.headers.get('content-disposition');
      let filename = `article-${Date.now()}.pdf`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="(.+?)"/);
        if (match && match[1]) {
          filename = match[1];
        }
      }

      // Download file in browser
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);

      showStatus(`SUCCESS: "${filename}" downloaded!`, 'success');

    } catch (err) {
      console.error(err);
      showStatus(`Error: ${err.message}`, 'error');
    } finally {
      clipBtn.disabled = false;
      clipBtn.innerHTML = '<span>Generate Premium PDF</span>';
    }
  });
});
