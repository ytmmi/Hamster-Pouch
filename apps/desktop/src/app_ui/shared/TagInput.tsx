/**
 * 标签输入组件 — 融合 chips 与内联输入：
 * 点击任意位置聚焦输入框，回车把输入内容变成标签，标签上的 ✕ 移除；
 * 输入为空时退格删除最后一个标签。
 */

import { useRef, useState, type KeyboardEvent } from "react";

export interface TagInputItem {
  id: string;
  name: string;
}

export interface TagInputProps {
  tags: TagInputItem[];
  placeholder: string;
  /** 标签移除按钮的提示文字（由调用方注入 i18n 文案）。 */
  removeTitle: string;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
}

export function TagInput({
  tags,
  placeholder,
  removeTitle,
  onAdd,
  onRemove,
}: TagInputProps): JSX.Element {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = () => {
    const name = value.trim();
    if (!name) {
      return;
    }
    onAdd(name);
    setValue("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && value === "" && tags.length > 0) {
      onRemove(tags[tags.length - 1].name);
    }
  };

  return (
    <div className="tag-input" onClick={() => inputRef.current?.focus()}>
      {tags.map((t) => (
        <span key={t.id} className="tag-pill">
          {t.name}
          <button
            className="tag-pill-x"
            title={removeTitle}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(t.name);
            }}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="tag-input-field"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
