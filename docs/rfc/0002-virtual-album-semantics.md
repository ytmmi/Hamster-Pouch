# RFC 0002：虚拟相册语义与数据模型

状态：正式草案。已确认方向：虚拟相册采用“成员关系 + 同步规则 + 媒体属性”。

## 用户确认后的语义

- 虚拟相册类似共享相册：它是图像成员的容器，不直接拥有真实文件。
- “创建时固定”类似创建虚拟相册时把当前选中的图像登记进相册；之后不自动跟随媒体源变化。
- “跟随源”类似同步：相册保存同步规则，媒体源变化时按规则维护成员关系。
- 相册有媒体属性（`media_type`）：设定后，相册只显示该属性包含类型的文件。

## 决策

1. 固定型虚拟相册：只保存显式成员关系。
2. 跟随源型虚拟相册：保存显式成员关系，同时保存同步规则与同步状态。
3. 媒体源和虚拟相册都允许嵌套。
4. 虚拟相册不复制真实文件；真实文件只在媒体源之间发生复制/剪切/移动时才改变硬盘位置。
5. 相册成员关系按仓库隔离；同一个本地媒体源被多个仓库挂载时，各仓库的相册成员、tag、评分互不影响。
6. 相册媒体属性枚举为 `image` / `video` / `audio` / `multimedia`（=图片+视频+音频）；可选，默认 `multimedia`；创建后可修改。后续可扩展新枚举值。
7. 相册只显示 `media_type` 包含类型的文件；修改属性时自动移除不匹配成员，移除前 UI 确认并写操作历史；手动添加成员时拒绝不匹配类型的文件。
8. 嵌套相册的 `media_type` 默认继承父相册，可显式覆盖。
9. 跟随源型相册的同步规则含独立 `media_type` 过滤字段，同步时只拉取匹配类型；相册属性变更时联动更新该字段。

## 数据模型草案

```text
album
- id
- repo_id
- parent_album_id 可空
- name
- kind: fixed | follow_source
- media_type: image | video | audio | multimedia   # 可空 = 继承父相册；顶层可空视作 multimedia
- created_at
- updated_at

album_member
- album_id
- file_id
- added_at
- added_by: user | sync_rule
- pinned: bool                 # 跟随型中用户手动固定成员，防止被同步移除

album_sync_rule
- album_id
- source_id
- include_subsources: bool
- media_type: image | video | audio | multimedia  # 独立过滤字段，与相册属性联动
- filter_json                  # tag/评分/类型/路径等筛选；具体 DSL 属于实现期开放点
- sync_mode: add_only | mirror # 只增量加入，还是镜像移除
- enabled: bool

album_sync_state
- album_id
- source_id
- last_synced_at
- last_scan_cursor
- status
```

## 行为规则

### 媒体属性规则（所有相册类型）

- 相册只显示 `media_type` 包含类型的文件；显示层过滤，不改变成员关系。
- `multimedia` 包含 image + video + audio；`image`/`video`/`audio` 只含单一类型。
- 修改相册属性时：自动移除不匹配的新属性的成员；移除前必须 UI 确认并写入操作历史。
- 手动向相册添加成员时：不匹配相册属性的文件被拒绝并提示。
- 嵌套相册：`media_type` 为空表示继承父相册；显式设置则覆盖。顶层相册空值视作 `multimedia`。

### 固定型相册

- 创建时可从当前媒体源选择图像并写入 `album_member`。
- 后续源新增/删除/移动不自动改变成员。
- 文件缺失时保留成员关系并显示缺失状态。

### 跟随源型相册

- 创建时保存 `album_sync_rule`，并按规则初始化成员。
- 同步时只拉取与 `media_type` 匹配的文件（`multimedia` 拉取全部）。
- 源新增文件且匹配规则：加入成员，`added_by=sync_rule`。
- 源文件缺失或不再匹配规则：
  - `add_only`：保留成员，标记为规则不再匹配。
  - `mirror`：移除非 pinned 成员；pinned 成员保留。
- 相册属性变更时，`album_sync_rule.media_type` 由宿主联动更新为新属性值。
- 用户手动加入的成员默认 `pinned=true` 还是仅 `added_by=user` 属于实现期开放点；不得改变“成员关系 + 同步规则”的架构决策。

## 风险

- `mirror` 模式可能移除用户以为还存在的成员，需要 UI 明确提示。
- 修改相册媒体属性会自动移除不匹配成员，同样需要 UI 明确提示与确认。
- 嵌套相册是否继承父相册规则会显著改变查询复杂度。
- 规则筛选如果引用 tag/评分，而 tag/评分按仓库隔离，则同步规则只能在当前仓库内求值。
- 第一期音频文件只有占位行（无哈希/缩略图），`audio` 相册在占位行升级前无法提供预览与相似检索。

## 实现期开放点（非架构决策）

- 嵌套虚拟相册是否继承父相册的成员关系或同步规则（媒体属性已确认：默认继承、可覆盖）。
- 跟随源型相册默认 `add_only` 还是 `mirror`。
- 用户手动加入跟随型相册的成员是否默认 pinned。
- `filter_json` 的 DSL 范围：仅路径/类型，还是包含 tag、评分、颜色、AI 标签。
- 后续新增媒体类型枚举值时的迁移方式。
