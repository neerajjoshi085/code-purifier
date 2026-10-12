import { memo, useCallback, useRef, useState } from 'react';
import { actions } from '../hooks/appStore.js';
import { itemsFromDataTransfer } from '../project/fileReader.js';
import { UPLOAD_PRIVACY } from '../utils/constants.js';
import { Icon } from './Icons.jsx';

const ACCEPT = '.html,.htm,.css,.js,.mjs,.jsx,.zip';

function Dropzone({ compact = false }) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const fileInput = useRef(null);
  const folderInput = useRef(null);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    try {
      const items = await itemsFromDataTransfer(e.dataTransfer);
      if (items.length) actions.addItems(items);
    } catch (err) {
      actions.toast(`Could not read the dropped items: ${err.message}`, 'error');
    }
  }, []);

  const onChoose = (e) => {
    if (e.target.files?.length) actions.addFileList(e.target.files);
    e.target.value = '';
  };

  const dragProps = {
    onDragEnter: (e) => {
      e.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (e) => e.preventDefault(),
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop,
  };

  return (
    <div className={`dropzone${compact ? ' dropzone--compact' : ''}${dragging ? ' is-dragging' : ''}`} {...dragProps}>
      <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={onChoose} />
      <input ref={folderInput} type="file" hidden onChange={onChoose} webkitdirectory="" directory="" multiple />
      <div className="dropzone__icon" aria-hidden="true">
        <Icon name={dragging ? 'download' : 'upload'} size={compact ? 20 : 30} strokeWidth={1.6} />
      </div>
      <div className="dropzone__text">
        <p className="dropzone__title">{dragging ? 'Release to add your files' : compact ? 'Add more files' : 'Drop your website here'}</p>
        {!compact && (
          <p className="dropzone__sub">
            HTML, CSS and JavaScript (<code>.js</code> <code>.mjs</code> <code>.jsx</code>) files — or a <code>.zip</code> of the whole site. Folders work too.
          </p>
        )}
      </div>
      <div className="dropzone__actions">
        <button type="button" className="btn btn--primary" onClick={() => fileInput.current?.click()}>
          <Icon name="file" size={16} /> Choose files
        </button>
        <button type="button" className="btn" onClick={() => folderInput.current?.click()}>
          <Icon name="folder" size={16} /> Choose folder
        </button>
      </div>
      {!compact && (
        <p className="dropzone__privacy">
          <Icon name="lock" size={14} /> {UPLOAD_PRIVACY}
        </p>
      )}
    </div>
  );
}

export default memo(Dropzone);
