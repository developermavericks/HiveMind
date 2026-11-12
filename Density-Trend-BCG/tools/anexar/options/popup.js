var ext_api = chrome || browser;
var manifestData = ext_api.runtime.getManifest();
var ext_chromium = !!manifestData.key;
var ext_manifest_version = manifestData.manifest_version;
var navigator_ua = navigator.userAgent;
var navigator_ua_mobile = navigator_ua.toLowerCase().includes('mobile');
var custom_switch = ((manifestData.optional_permissions && manifestData.optional_permissions.length) || (manifestData.optional_host_permissions && manifestData.optional_host_permissions.length));

// htmlviewer: clean layout
ext_api.tabs.query({
  active: true,
  currentWindow: true
}, function (tabs) {
  if (tabs && tabs[0] && ((tabs[0].url === 'about:blank' && tabs[0].title !== 'about:blank') || tabs[0].url === 'https://codebeautify.org/htmlviewer')) {
    let tabId = tabs[0].id;
    if (ext_manifest_version === 2) {
      ext_api.tabs.executeScript(tabId, {
        file: '/options/htmlviewer.js'
      }, function (res) {
        if (ext_api.runtime.lastError || res[0]) {
          return;
        }
      });
    } else if (ext_manifest_version === 3) {
      ext_api.scripting.executeScript({
        target: {tabId: tabId},
        files: ["/options/htmlviewer.js"]
      })
    }
  }
});

function popup_show_toggle(domain, enabled) {
  if (domain) {
    var site_switch_span = document.getElementById('site_switch_span');
    let labelEl = document.createElement('label');
    labelEl.setAttribute('class', 'switch');
    let inputEl = document.createElement('input');
    inputEl.setAttribute('id', 'site_switch');
    inputEl.setAttribute('type', 'checkbox');
    if (enabled)
      inputEl.setAttribute('checked', true);
    labelEl.appendChild(inputEl);
    let spanEl = document.createElement('span');
    spanEl.setAttribute('class', 'slider round');
    spanEl.setAttribute('title', 'en/disable current site/group in BPC');
    labelEl.appendChild(spanEl);
    site_switch_span.appendChild(labelEl);
    document.getElementById("site_switch").addEventListener('click', function () {
      ext_api.runtime.sendMessage({
        request: 'site_switch'
      });
      //open(location).close();
    });
  }
};

ext_api.runtime.sendMessage({
  request: 'popup_show_toggle'
});
ext_api.runtime.onMessage.addListener(function (message, sender) {
  if (message.msg === 'popup_show_toggle' && message.data) {
    popup_show_toggle(message.data.domain, message.data.enabled)
  }
});

var cookie_domain;
ext_api.tabs.query({
  active: true,
  currentWindow: true
}, function (tabs) {
  if (tabs && tabs[0] && /^http/.test(tabs[0].url)) {
    let hostname = new URL(tabs[0].url).hostname;
    cookie_domain = getCookiePermDomain(hostname);
  }
});

document.getElementById("clear_cookies").addEventListener('click', function () {
if (custom_switch)
  ext_api.permissions.request({
    origins: ["*://*." + cookie_domain + "/*"]
  }, function (granted) {
    if (granted) {
      ext_api.runtime.sendMessage({
        request: 'clear_cookies'
      });
    }
  });
else
  ext_api.permissions.contains({
    origins: ["*://*." + cookie_domain + "/*"]
  }, function (result) {
    if (result) {
      ext_api.runtime.sendMessage({
        request: 'clear_cookies'
      });
    }
  });
});

function showArchiveLinks() {
  ext_api.tabs.query({
    active: true,
    currentWindow: true
  }, function (tabs) {
    if (tabs && tabs[0] && /^http/.test(tabs[0].url)) {
      let url = tabs[0].url;
      let hostname = urlHost(url);
      let url_enc = encodeURIComponent(url);
      let archive_array = {
        'Archive.today': 'https://archive.today?run=1&url=' + url_enc,
        'Clearthis.page': 'https://clearthis.page?u=' + url_enc,
        'Google Search Tool\n(see help - troubleshooting)': 'https://search.google.com/test/rich-results?url=' + url_enc
      };
      let archive_id = document.querySelector('span#archive');
      if (archive_id) {
        archive_id.appendChild(document.createTextNode('Open tab in:'));
        for (let key in archive_array) {
          let elem_div = document.createElement('div');
          let elem = document.createElement('a');
          elem.innerText = key;
          if (!(matchDomain(['clearthis.page', 'google.com'], hostname) || hostname.match(/^archive\.\w{2}$/))) {
            elem.href = archive_array[key];
            elem.title = elem.href;
            elem.target = '_blank';
            elem_div.appendChild(elem);
            archive_id.appendChild(elem_div);
          }
        }
      }
    }
  });
}
showArchiveLinks();

function matchDomain(domains, hostname = window.location.hostname) {
  if (typeof domains === 'string')
    domains = [domains];
  return domains.find(domain => hostname === domain || hostname.endsWith('.' + domain)) || false;
}

function urlHost(url) {
  if (/^http/.test(url)) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      console.log(`url not valid: ${url} error: ${e}`);
    }
  }
  return url;
}

function closeButton() {
  window.close();
}

function getCookiePermDomain(hostname) {
  let domain = hostname.replace(/^(www|amp(html)?|m|wap)(\d)?\./, '');
  let domain_split = domain.split('.');
  let num = 2;
  if (domain_split.length > 2 && domain.match(/(\w){2,4}\.(\w){2}$/))
    num = 3;
  domain = domain_split.slice(-num).join('.');
  return domain;
}

function new_tab(url) {
  if (url) {
    window.close();
    ext_api.tabs.create({url: url});
    return false;
  }
}

window.setTimeout(function () {
  if (!ext_chromium && navigator_ua_mobile) {
    let ext_links = document.querySelectorAll('a[href^="https"]');
    for (let elem of ext_links)
      elem.onclick = x => new_tab(elem.href);
  }
}, 500);

document.getElementById("button-close").addEventListener('click', closeButton);

// --- Anexar Web Clipper Integration ---
document.addEventListener('DOMContentLoaded', () => {
  const clipBtn = document.getElementById('clip-btn');
  const statusBox = document.getElementById('status-box');

  if (!clipBtn || !statusBox) return;

  let currentEnv = 'production';

  // Load saved preference silently from storage
  ext_api.storage.local.get(['anexar_env'], (res) => {
    if (res.anexar_env) {
      currentEnv = res.anexar_env;
    }
  });

  function showStatus(text, type) {
    statusBox.textContent = text;
    statusBox.style.color = type === 'error' ? '#f87171' : type === 'success' ? '#34d399' : '#d97706';
  }

  function getActiveTabHtml() {
    return new Promise((resolve, reject) => {
      ext_api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) {
          reject(new Error('No active browser tab found.'));
          return;
        }

        const activeTab = tabs[0];
        if (!activeTab.url || activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('edge://')) {
          reject(new Error('Cannot clip internal browser system pages.'));
          return;
        }

        ext_api.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => document.documentElement.outerHTML
        }, (results) => {
          if (ext_api.runtime.lastError) {
            reject(new Error(ext_api.runtime.lastError.message));
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
    clipBtn.textContent = 'Processing...';

    try {
      const pageData = await getActiveTabHtml();
      showStatus('Uploading content & generating premium A4 PDF...', 'info');

      const targetApi = currentEnv === 'local' 
        ? 'http://localhost:3100/api/generate-article-pdf'
        : 'https://generatearticlepdf-mjsmlxvrgq-uc.a.run.app/api/generate-article-pdf';

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
      clipBtn.textContent = 'Generate Premium PDF';
    }
  });
});
