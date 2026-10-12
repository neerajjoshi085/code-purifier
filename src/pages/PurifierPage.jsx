import { useEffect } from 'react';
import Hero from '../components/Hero.jsx';
import Workspace from '../components/Workspace.jsx';
import HowItWorks from '../components/HowItWorks.jsx';
import { actions } from '../hooks/appStore.js';

/** Shared by the "CSS Purifier" and "JS Purifier" routes — same project, different emphasis. */
export default function PurifierPage({ lang }) {
  useEffect(() => {
    actions.setScope(lang);
    actions.setView({ lang, file: null, focusLine: null });
  }, [lang]);
  return (
    <>
      <Hero lang={lang} />
      <Workspace lang={lang} />
      <HowItWorks lang={lang} />
    </>
  );
}
