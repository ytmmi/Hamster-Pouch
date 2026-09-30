/**
 * 蓝图编辑器界面状态（RFC 0007 决策 7 / D31）——只持有"编辑器正在编辑什么"。
 *
 * 这里不出现任何后端命令：蓝图文档的读写走 `useBlueprintDocuments`（`api.blueprint*`）。
 * 本文件持有编辑中的图文档、与之同步的 JSON 文本、选中项、视图模式、提示与忙碌标记，
 * 并提供统一的文档改写入口（`mutate` / `syncFromJson`），保证"文档变了 JSON 文本跟着变"
 * 这一条不变式只有一个实现。
 *
 * 与运行时状态（`blueprintRuntime` 的生效蓝图与当前层）是两回事：这里是编辑器自己的副本。
 */

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

import { makeEmptyBlueprint, type BlueprintGraph } from "@hamster-pouch/config";

import type { Point } from "./blueprintGeometry";
import { normalizePositions } from "./blueprintSlots";

/** 编辑视图：节点画布 / JSON 文本（两者互斥）。 */
export type BlueprintViewMode = "canvas" | "json";

/** 编辑器界面状态与改写动作。 */
export interface BlueprintEditorState {
  /** 编辑中的图文档。 */
  doc: BlueprintGraph;
  setDoc: Dispatch<SetStateAction<BlueprintGraph>>;
  /** 与文档同步的 JSON 文本（JSON 视图编辑用）。 */
  jsonText: string;
  setJsonText: Dispatch<SetStateAction<string>>;
  /** 编辑器里的蓝图名称输入。 */
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  /** 新建蓝图时的名称输入。 */
  newName: string;
  setNewName: Dispatch<SetStateAction<string>>;
  /** 当前选中的蓝图 id（null = 未选中）。 */
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  /** 当前选中的节点 key（null = 未选中）。 */
  selectedKey: string | null;
  setSelectedKey: Dispatch<SetStateAction<string | null>>;
  viewMode: BlueprintViewMode;
  setViewMode: Dispatch<SetStateAction<BlueprintViewMode>>;
  /** 校验错误（保存被拒 / JSON 解析失败）；空数组 = 无错误。 */
  errors: string[];
  setErrors: Dispatch<SetStateAction<string[]>>;
  /** 后端命令进行中（按钮禁用）。 */
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  /** 画布渲染视口中心（世界坐标）：新增节点落点用。 */
  viewCenter: Point | null;
  setViewCenter: Dispatch<SetStateAction<Point | null>>;
  /** 新建蓝图时是否带上当前布局的结构骨架（界面→布局块→标签组→面板控件）。 */
  withStructure: boolean;
  setWithStructure: Dispatch<SetStateAction<boolean>>;
  /**
   * 编辑器当前层（D51：画布同一时刻只渲染一个层）。
   * 与运行时"当前层"（D54，按仓库持久化）同步：切层时一并套用该层布局。
   */
  layerKey: string | null;
  setLayerKey: Dispatch<SetStateAction<string | null>>;
  /** 统一变更文档并同步 JSON 文本。 */
  mutate: (next: BlueprintGraph) => void;
  /** 把 JSON 文本解析回文档；解析失败只记错误，不动文档。 */
  syncFromJson: () => void;
}

export function useBlueprintEditorState(): BlueprintEditorState {
  const [doc, setDoc] = useState<BlueprintGraph>(() => makeEmptyBlueprint());
  const [jsonText, setJsonText] = useState<string>(() =>
    JSON.stringify(makeEmptyBlueprint(), null, 2),
  );
  const [name, setName] = useState("");
  const [newName, setNewName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<BlueprintViewMode>("canvas");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /** 画布渲染视口中心（世界坐标）：新增节点落点用。 */
  const [viewCenter, setViewCenter] = useState<Point | null>(null);
  /** 新建蓝图时是否带上当前布局的结构骨架（界面→布局块→标签组→面板控件）。 */
  const [withStructure, setWithStructure] = useState(true);
  /**
   * 编辑器当前层（D51：画布同一时刻只渲染一个层）。
   * 与运行时"当前层"（D54，按仓库持久化）同步：切层时一并套用该层布局。
   */
  const [layerKey, setLayerKey] = useState<string | null>(null);

  /** 统一变更文档并同步 JSON 文本。 */
  const mutate = useCallback((next: BlueprintGraph) => {
    setDoc(next);
    setJsonText(JSON.stringify(next, null, 2));
  }, []);

  /** JSON 视图 → 文档：解析成功才替换文档（缺 `position` 的节点按槽位补齐），失败只记错误。 */
  const syncFromJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText) as BlueprintGraph;
      setDoc(normalizePositions(parsed));
      setErrors([]);
    } catch (e) {
      setErrors([String(e)]);
    }
  }, [jsonText]);

  return {
    doc,
    setDoc,
    jsonText,
    setJsonText,
    name,
    setName,
    newName,
    setNewName,
    selectedId,
    setSelectedId,
    selectedKey,
    setSelectedKey,
    viewMode,
    setViewMode,
    errors,
    setErrors,
    busy,
    setBusy,
    viewCenter,
    setViewCenter,
    withStructure,
    setWithStructure,
    layerKey,
    setLayerKey,
    mutate,
    syncFromJson,
  };
}
