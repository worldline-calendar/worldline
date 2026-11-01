// A card or dialog drawn at the page's top level, not inside whatever opened it — so on a phone a card opened from
// the sidebar drawer covers the whole screen, and the drawer (moved with a CSS transform) can't clip it.
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export const Portal = ({ children }: { children: ReactNode }) => createPortal(children, document.body);
