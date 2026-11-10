/**
 * 出厂默认布局（D158）：随包「演示仓库」首次播种用的布局形状。
 *
 * 与 `blueprintDefault.ts` 的 `DEFAULT_BLUEPRINT` **逐层配对**——`l_main`（主界面）挂 13 个面板，
 * `l_2`（界面 2）只挂 `sources`。两者必须一起改：只改一侧，全新安装就会出现「界面有面板、
 * 画布无节点」（或反之），这正是 v7 时代默认蓝图停在单层留下的缺陷（D155/D158）。
 *
 * `""` 是层无关快照，语义上等同 `l_main`：解析时先取当前层、再取 `""`（RFC 0011 决策 1）。
 * 面板标题**不写在这里**——文案随语言变化，播种时由 `panelTitle(id, t)` 现填。
 *
 * 改这个常量后必须跑 `pnpm check:blueprint-pair`（CI 也跑）：它会逐层比对面板集合。
 */

/** 单层布局状态（dockview `toJSON` 的形状，只声明本文件用到的字段）。 */
export interface LayoutLayerState {
  grid?: { root?: unknown; width?: number; height?: number; orientation?: string };
  panels?: Record<
    string,
    {
      id?: string;
      contentComponent?: string;
      renderer?: string;
      title?: string;
      minimumWidth?: number;
      minimumHeight?: number;
    }
  >;
  activeGroup?: string;
}

/** 按蓝图层 key 存放的出厂布局。`""` = 层无关快照。 */
export const DEFAULT_LAYOUT_LAYERS: Readonly<Record<string, LayoutLayerState>> = {
  l_main: {
    "grid": {
      "root": {
        "type": "branch",
        "data": [
          {
            "type": "branch",
            "data": [
              {
                "type": "leaf",
                "data": {
                  "views": [
                    "repo",
                    "tasks"
                  ],
                  "activeView": "repo",
                  "id": "1"
                },
                "size": 133
              },
              {
                "type": "leaf",
                "data": {
                  "views": [
                    "sources",
                    "albums"
                  ],
                  "activeView": "albums",
                  "id": "2"
                },
                "size": 611
              }
            ],
            "size": 213
          },
          {
            "type": "leaf",
            "data": {
              "views": [
                "media",
                "player",
                "imageviewer",
                "bookpreview",
                "bookreader"
              ],
              "activeView": "media",
              "id": "4"
            },
            "size": 825
          },
          {
            "type": "branch",
            "data": [
              {
                "type": "leaf",
                "data": {
                  "views": [
                    "color"
                  ],
                  "activeView": "color",
                  "id": "6"
                },
                "size": 93
              },
              {
                "type": "leaf",
                "data": {
                  "views": [
                    "viewer",
                    "tags"
                  ],
                  "activeView": "viewer",
                  "id": "7"
                },
                "size": 361
              },
              {
                "type": "leaf",
                "data": {
                  "views": [
                    "metadata"
                  ],
                  "activeView": "metadata",
                  "id": "10"
                },
                "size": 290
              }
            ],
            "size": 230
          }
        ],
        "size": 744
      },
      "width": 1268,
      "height": 744,
      "orientation": "HORIZONTAL"
    },
    "panels": {
      "repo": {
        "id": "repo",
        "contentComponent": "repo",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "tasks": {
        "id": "tasks",
        "contentComponent": "tasks",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "sources": {
        "id": "sources",
        "contentComponent": "sources",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "albums": {
        "id": "albums",
        "contentComponent": "albums",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "media": {
        "id": "media",
        "contentComponent": "media",
        "renderer": "always",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "player": {
        "id": "player",
        "contentComponent": "player",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "imageviewer": {
        "id": "imageviewer",
        "contentComponent": "imageviewer",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "bookpreview": {
        "id": "bookpreview",
        "contentComponent": "bookpreview",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "bookreader": {
        "id": "bookreader",
        "contentComponent": "bookreader",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "color": {
        "id": "color",
        "contentComponent": "color",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "viewer": {
        "id": "viewer",
        "contentComponent": "viewer",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "tags": {
        "id": "tags",
        "contentComponent": "tags",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "metadata": {
        "id": "metadata",
        "contentComponent": "metadata",
        "minimumHeight": 22,
        "minimumWidth": 6
      }
    },
    "activeGroup": "2"
  },
  l_2: {
    "grid": {
      "root": {
        "type": "branch",
        "data": [
          {
            "type": "leaf",
            "data": {
              "views": [
                "sources"
              ],
              "activeView": "sources",
              "id": "1"
            },
            "size": 1280
          }
        ],
        "size": 1280
      },
      "width": 1280,
      "height": 744,
      "orientation": "HORIZONTAL"
    },
    "panels": {
      "sources": {
        "id": "sources",
        "contentComponent": "sources"
      }
    },
    "activeGroup": "1"
  },
  "": {
    "grid": {
      "root": {
        "type": "branch",
        "data": [
          {
            "type": "branch",
            "data": [
              {
                "type": "leaf",
                "data": {
                  "views": [
                    "repo",
                    "tasks"
                  ],
                  "activeView": "repo",
                  "id": "1"
                },
                "size": 133
              },
              {
                "type": "leaf",
                "data": {
                  "views": [
                    "sources",
                    "albums"
                  ],
                  "activeView": "albums",
                  "id": "2"
                },
                "size": 611
              }
            ],
            "size": 213
          },
          {
            "type": "leaf",
            "data": {
              "views": [
                "media",
                "player",
                "imageviewer",
                "bookpreview",
                "bookreader"
              ],
              "activeView": "media",
              "id": "4"
            },
            "size": 825
          },
          {
            "type": "branch",
            "data": [
              {
                "type": "leaf",
                "data": {
                  "views": [
                    "color"
                  ],
                  "activeView": "color",
                  "id": "6"
                },
                "size": 93
              },
              {
                "type": "leaf",
                "data": {
                  "views": [
                    "viewer",
                    "tags"
                  ],
                  "activeView": "viewer",
                  "id": "7"
                },
                "size": 361
              },
              {
                "type": "leaf",
                "data": {
                  "views": [
                    "metadata"
                  ],
                  "activeView": "metadata",
                  "id": "10"
                },
                "size": 290
              }
            ],
            "size": 230
          }
        ],
        "size": 744
      },
      "width": 1268,
      "height": 744,
      "orientation": "HORIZONTAL"
    },
    "panels": {
      "repo": {
        "id": "repo",
        "contentComponent": "repo",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "tasks": {
        "id": "tasks",
        "contentComponent": "tasks",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "sources": {
        "id": "sources",
        "contentComponent": "sources",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "albums": {
        "id": "albums",
        "contentComponent": "albums",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "media": {
        "id": "media",
        "contentComponent": "media",
        "renderer": "always",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "player": {
        "id": "player",
        "contentComponent": "player",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "imageviewer": {
        "id": "imageviewer",
        "contentComponent": "imageviewer",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "bookpreview": {
        "id": "bookpreview",
        "contentComponent": "bookpreview",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "bookreader": {
        "id": "bookreader",
        "contentComponent": "bookreader",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "color": {
        "id": "color",
        "contentComponent": "color",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "viewer": {
        "id": "viewer",
        "contentComponent": "viewer",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "tags": {
        "id": "tags",
        "contentComponent": "tags",
        "minimumHeight": 22,
        "minimumWidth": 6
      },
      "metadata": {
        "id": "metadata",
        "contentComponent": "metadata",
        "minimumHeight": 22,
        "minimumWidth": 6
      }
    },
    "activeGroup": "2"
  },
};
