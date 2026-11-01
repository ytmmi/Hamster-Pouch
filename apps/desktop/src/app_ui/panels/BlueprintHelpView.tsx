/**
 * 画布「?」帮助面板（D136-B）——展示层。
 *
 * 用户需求：「蓝图右下角增加"?"，点击显示**所有节点的包含关系**」。
 * 内容全部来自纯模块 `blueprintHelp.ts`（它从节点定义表派生，见那里的文件头注释）；
 * 本文件只负责**渲染与开关交互**，不持有任何父子关系知识。
 *
 * ## 角落布局：三层竖排（浮层 / `?` 按钮 / 小地图）
 *
 * 画布右下角已经放了小地图（`.bp-minimap`：`right/bottom: 8px`，`width: 176px`，
 * 实高约 136px，顶边距底约 144px）。小地图**整块都是拖拽热区**，任何叠在它上面的
 * 东西都会抢走拖动，因此这里沿右边缘从下往上排三层，互不重叠：
 *
 * ```
 *   ┌──────────────┐
 *   │  .bp-help-popover（浮层，可滚动）
 *   ├──────────────┤   ← 间距 8px
 *   │  ? 按钮 28px  │
 *   ├──────────────┤   ← 间距 10px（按钮 bottom:154px，小地图顶边距底约 144px）
 *   │  .bp-minimap  │
 *   └──────────────┘   ← 8px 距画布底部
 * ```
 *
 * 按钮 `bottom: 154px` 是**唯一与下方面板尺寸耦合的常量**，见 `styles.css`
 * 里 `.bp-help-toggle` 的注释（小地图高度由 `blueprintMinimapGeometry.MINIMAP_SIZE`
 * 的 176×120 与 `.bp-minimap` 的内边距/标签行推出）。
 * 浮层用 `top: 8px; bottom: 190px`（= 按钮 154 + 按钮高 28 + 间距 8）撑满剩余高度，
 * 因此**任何画布高度下都不会被裁切**，内容超出时在浮层内滚动。
 *
 * ## 层级：z-index 30
 *
 * - 高于画布内容（节点 `z-index: 1/2` 且都在 `.bp-canvas-world` 的变换层内）与小地图
 *   / 图例（无 z-index）；
 * - **低于**设置浮层（`.settings-overlay`，60）与右键菜单（`.context-menu`，2000）——
 *   帮助是"常驻查询面板"，不该盖住用户正在用的菜单，也不该盖在设置界面上。
 *
 * ## 关闭方式（三种都支持）
 *
 * 再点 `?`、点浮层外、按 Esc。点浮层外靠 `document` 的 click 监听实现：
 * 浮层与按钮自身 `stopPropagation`（否则点击内容会立刻关掉）。
 */

import { useCallback, useEffect, useMemo, type JSX } from "react";

import type { Translate, TranslationKey } from "../i18n";

import {
  buildEdgeRules,
  buildHierarchyTree,
  buildRuleEdges,
  logicNodeTypes,
  parentsOf,
  type HelpTreeNode,
} from "./blueprintHelp";
/** 配色沿用节点/边色板（纯数据模块，画布与小地图共用同一份）。 */
import { edgeColor, nodeColor } from "./blueprintNodeColors";
import { nodeTypeLabel } from "./blueprintLabels";

export interface BlueprintHelpProps {
  /** 浮层是否展开。 */
  open: boolean;
  /** 点 `?` 或浮层内「关闭」时收起（状态由画布持有，避免两处各存一份）。 */
  onClose: () => void;
  /** 点 `?` 时切换（打开↔收起）。 */
  onToggle: () => void;
  t: Translate;
}

/** 类型名复用 `blueprint.type.<type>` 键（未注册类型由 `nodeTypeLabel` 标注未接通）。 */
function typeLabel(type: string, t: Translate): string {
  return nodeTypeLabel(type, t);
}

/**
 * 缩进层级树的递归渲染。
 *
 * 行末的 `←` 是**反向信息**（`parentsOf`）：一个类型可挂在多个父下（如对象可挂
 * 类目/子类/标记），因此会在树里出现多次；行尾列出它的全部父级，避免读者以为
 * 树里重复是绘图错误。
 */
function renderNode(node: HelpTreeNode, depth: number, t: Translate): JSX.Element {
  const parents = parentsOf(node.type);
  return (
    <li key={`${depth}:${node.type}`}>
      <div className="bp-help-tree-row" style={{ paddingLeft: `${depth * 14}px` }}>
        <i className="bp-help-dot" style={{ background: nodeColor(node.type) }} />
        <span className="bp-help-type">{typeLabel(node.type, t)}</span>
        {parents.length > 0 && (
          <span className="bp-help-parents">
            ← {parents.map((p) => typeLabel(p, t)).join(" / ")}
          </span>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="bp-help-tree">
          {node.children.map((child) => renderNode(child, depth + 1, t))}
        </ul>
      )}
    </li>
  );
}

/** 帮助面板：「?」按钮 + 可滚动浮层（层级树 / 包含关系表 / 边类型说明）。 */
export function BlueprintHelpView({
  open,
  onClose,
  onToggle,
  t,
}: BlueprintHelpProps): JSX.Element {
  /**
   * 内容按 `open` 重新派生：定义表在**运行时**可变（插件可在运行中注册节点类型），
   * 因此每次打开都取当前注册表的层级，而不是在模块初始化时快照一次。
   */
  const content = useMemo(
    () => ({
      roots: buildHierarchyTree(),
      rules: buildEdgeRules(),
      ruleEdges: buildRuleEdges(),
      logicTypes: logicNodeTypes(),
    }),
    [open],
  );

  /** 浮层内部的点击（含按钮）不冒泡到 `document`，否则会被"点外关闭"当场关掉。 */
  const stop = useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation();
  }, []);

  // Esc 收起；点浮层外收起（`document` click，与画布其它浮层同一模式）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClose);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClose);
    };
  }, [open, onClose]);

  return (
    <>
      <button
        type="button"
        className={`bp-help-toggle ${open ? "active" : ""}`}
        aria-label={t("blueprint.help.open")}
        aria-expanded={open}
        title={t("blueprint.help.title")}
        // 截断冒泡，否则会被 document 的"点外关闭"当场关掉。
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        // 画布的指针语义（平移/刀痕/连线）不该被这个按钮吃掉。
        onPointerDown={stop}
      >
        ?
      </button>

      {open && (
        <div
          className="bp-help-popover"
          role="dialog"
          aria-label={t("blueprint.help.title")}
          onClick={stop}
          onPointerDown={stop}
          onContextMenu={stop}
          onWheel={stop}
        >
          <div className="bp-help-head">
            <span className="bp-help-title">{t("blueprint.help.title")}</span>
            <button
              type="button"
              className="bp-help-close"
              aria-label={t("blueprint.help.close")}
              title={t("blueprint.help.close")}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              ✕
            </button>
          </div>

          {/* ① 缩进层级树：根由定义表推出（内置 12 种下唯一根 = 界面）。 */}
          <section className="bp-help-section">
            <h4 className="bp-help-heading">{t("blueprint.help.hierarchy")}</h4>
            <p className="bp-help-note">{t("blueprint.help.hierarchyHint")}</p>
            <ul className="bp-help-tree">
              {content.roots.map((root) => renderNode(root, 0, t))}
            </ul>
          </section>

          {/* ② 包含关系表（父 → 子），由端口表的 CONTAINMENT 派生。 */}
          <section className="bp-help-section">
            <h4 className="bp-help-heading">{t("blueprint.help.rules")}</h4>
            <p className="bp-help-note">{t("blueprint.help.rulesHint")}</p>
            <table className="bp-help-table">
              <thead>
                <tr>
                  <th>{t("blueprint.help.columnParent")}</th>
                  <th>{t("blueprint.help.columnChild")}</th>
                  <th>{t("blueprint.help.columnEdge")}</th>
                </tr>
              </thead>
              <tbody>
                {content.rules.map((rule) => (
                  <tr key={`${rule.parent}->${rule.child}`}>
                    <td>{typeLabel(rule.parent, t)}</td>
                    <td>{typeLabel(rule.child, t)}</td>
                    <td>
                      <span className="bp-help-edge-badge">
                        <i style={{ background: edgeColor(rule.edge) }} />
                        {t("blueprint.port.contains")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* ③ 连线类型说明：结构边 + 规则边（来源/目标从端口表派生）。 */}
          <section className="bp-help-section">
            <h4 className="bp-help-heading">{t("blueprint.help.edges")}</h4>
            <ul className="bp-help-edge-list">
              {/* 结构边本身：上面那张表已经逐条列出，这里只解释它的含义。 */}
              <li>
                <span className="bp-help-edge-badge">
                  <i style={{ background: edgeColor("contains") }} />
                  {t("blueprint.port.contains")}
                </span>
                <span className="bp-help-edge-desc">
                  {t("blueprint.help.edge.contains")}
                </span>
              </li>
              {content.ruleEdges.map((edge) => (
                <li key={edge.kind}>
                  <span className="bp-help-edge-badge">
                    <i style={{ background: edgeColor(edge.kind) }} />
                    {t(`blueprint.port.${edge.kind}` as TranslationKey)}
                  </span>
                  <span className="bp-help-edge-desc">
                    {t(`blueprint.help.edge.${edge.kind}` as TranslationKey)}
                  </span>
                  <span className="bp-help-edge-io">
                    {t("blueprint.help.allowed", {
                      from: edge.sources.map((s) => typeLabel(s, t)).join(" / "),
                      to: edge.targets.map((s) => typeLabel(s, t)).join(" / "),
                    })}
                  </span>
                </li>
              ))}
            </ul>

            {/* 规则三节点：不参与包含——依据是它们在定义表里没有 parents/children。 */}
            <p className="bp-help-note bp-help-rule-nodes">
              {t("blueprint.help.ruleNodes")}
              {content.logicTypes.length > 0 && (
                <>
                  {"："}
                  {content.logicTypes.map((type) => typeLabel(type, t)).join(" / ")}
                </>
              )}
              {"。"}
              {t("blueprint.help.ruleNodesHint")}
            </p>
          </section>
        </div>
      )}
    </>
  );
}
