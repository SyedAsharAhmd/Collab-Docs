import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

// StarterKit bundles the nodes and marks we need (paragraphs, bold, italic, headings,
// lists) plus undo/redo history. In M3 the Collaboration extension replaces the
// built-in history, because undo must only undo your own edits, not other users'.
export default function Editor() {
  const editor = useEditor({
    extensions: [StarterKit],
    content: '<p>Start typing…</p>',
  });

  return (
    <div className="editor">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor }) {
  // Tiptap v3 does not re-render React on every keystroke, so we subscribe to just
  // the state the buttons need. The component re-renders only when these values change.
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      h1: editor.isActive('heading', { level: 1 }),
      h2: editor.isActive('heading', { level: 2 }),
      bulletList: editor.isActive('bulletList'),
      orderedList: editor.isActive('orderedList'),
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
    }),
  });

  // focus() first so clicking a button keeps the cursor in the document.
  const run = (command) => () => command(editor.chain().focus()).run();

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <ToolButton label="Bold" active={state.bold} onClick={run((c) => c.toggleBold())}>
        <b>B</b>
      </ToolButton>
      <ToolButton label="Italic" active={state.italic} onClick={run((c) => c.toggleItalic())}>
        <i>I</i>
      </ToolButton>
      <ToolButton label="Heading 1" active={state.h1} onClick={run((c) => c.toggleHeading({ level: 1 }))}>
        H1
      </ToolButton>
      <ToolButton label="Heading 2" active={state.h2} onClick={run((c) => c.toggleHeading({ level: 2 }))}>
        H2
      </ToolButton>
      <ToolButton label="Bullet list" active={state.bulletList} onClick={run((c) => c.toggleBulletList())}>
        • List
      </ToolButton>
      <ToolButton label="Numbered list" active={state.orderedList} onClick={run((c) => c.toggleOrderedList())}>
        1. List
      </ToolButton>
      <ToolButton label="Undo" disabled={!state.canUndo} onClick={run((c) => c.undo())}>
        ↶
      </ToolButton>
      <ToolButton label="Redo" disabled={!state.canRedo} onClick={run((c) => c.redo())}>
        ↷
      </ToolButton>
    </div>
  );
}

function ToolButton({ label, active = false, disabled = false, onClick, children }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={active ? 'active' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
