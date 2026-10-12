import { memo, useState } from 'react';
import { Icon } from './Icons.jsx';
import { actions, useApp } from '../hooks/appStore.js';
import { describeLangDownload, describeTextZip, describeWebsiteDownload } from '../project/downloadManager.js';
import { zipInWorker } from '../workers/workerClient.js';
import { saveBlob, saveText } from '../utils/download.js';
import { formatBytes } from '../utils/format.js';
import { SAFETY_WARNINGS } from '../utils/constants.js';
import { scopeOf } from '../utils/scope.js';
import '../styles/panels.css';

async function perform(desc) {
  if (desc.kind === 'file') {
    saveText(desc.text, desc.filename, desc.mime);
    return;
  }
  const buffer = await zipInWorker(desc.entries);
  saveBlob(new Blob([buffer], { type: 'application/zip' }), desc.filename);
}

function DownloadPanel({ lang }) {
  const result = useApp((s) => s.result);
  const project = useApp((s) => s.project);
  const [busy, setBusy] = useState(null);
  if (!result) return null;

  const scope = scopeOf(lang);
  const own = scope.lang;
  const items = [
    { id: own, icon: 'code', title: `Download ${scope.label}`, desc: describeLangDownload(own, result) },
    { id: 'html', icon: 'file', title: 'Download HTML', desc: describeLangDownload('html', result) },
    { id: 'zip', icon: 'zip', title: 'Download ZIP', desc: describeTextZip(result, scope.kinds, `purified-${own}.zip`), sub: `All purified ${scope.label} and HTML` },
  ];
  const website = { id: 'site', icon: 'folder', title: 'Download Optimized Website', desc: describeWebsiteDownload(project, result, scope.kinds), sub: `Everything, with your original folder structure and assets — only the ${scope.label} is changed` };

  const run = async (item) => {
    if (!item.desc) return;
    setBusy(item.id);
    try {
      await perform(item.desc);
      actions.toast(`Downloaded ${item.desc.filename}`);
    } catch (err) {
      actions.toast(`Could not create the download: ${err.message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const sizeOf = (d) => (d ? formatBytes(d.kind === 'file' ? new Blob([d.text]).size : d.entries.reduce((a, e) => a + (e.data ? e.data.byteLength : (e.text || '').length), 0)) : '');
  const potential = result.findings.filter((f) => f.status === 'POTENTIALLY_UNUSED' && f.lang === own && !f.removed).length;

  return (
    <div className="downloads">
      {potential > 0 && (
        <p className="callout callout--warn" role="note">
          <Icon name="warn" size={16} /> {SAFETY_WARNINGS[own]} {potential} potentially unused {scope.label} {potential === 1 ? 'item was' : 'items were'} left in place.
        </p>
      )}
      <button className="download download--hero" onClick={() => run(website)} disabled={!!busy || project.length === 0}>
        <span className="download__icon">{busy === 'site' ? <span className="spinner" /> : <Icon name={website.icon} size={22} />}</span>
        <span className="download__body">
          <span className="download__title">{website.title}</span>
          <span className="download__sub">{website.sub} · {website.desc.entries.length} files · ≈{sizeOf(website.desc)} uncompressed</span>
        </span>
        <Icon name="download" size={20} />
      </button>
      <div className="downloads__grid">
        {items.map((it) => (
          <button key={it.id} className="download" onClick={() => run(it)} disabled={!it.desc || !!busy}>
            <span className="download__icon">{busy === it.id ? <span className="spinner" /> : <Icon name={it.icon} size={18} />}</span>
            <span className="download__body">
              <span className="download__title">{it.title}</span>
              <span className="download__sub">
                {it.desc ? (it.sub || (it.desc.kind === 'file' ? `${it.desc.filename} · ${sizeOf(it.desc)}` : `${it.desc.entries.length} files as ${it.desc.filename}`)) : 'Nothing to download'}
              </span>
            </span>
            <Icon name="download" size={16} />
          </button>
        ))}
      </div>
      <p className="muted small">Files are generated in your browser.</p>
    </div>
  );
}

export default memo(DownloadPanel);
