# 截图占位说明

此目录用于存放 README 中引用的截图。

## 需要的截图

### `before-after.png`

README 顶部效果演示图,用于社交分享时的 preview。

**拍摄建议**:
- 选一个繁体网页(推荐 zh.wikipedia.org 某词条页)
- 浏览器全屏,左右分屏对比
  - 左:未开启脚本(繁体原文)
  - 右:开启脚本后(简体)
- 或用前后滚动截图拼接

**技术规格**:
- 尺寸:1200×600 px(2:1 横图,社交卡片友好)
- 格式:PNG
- 压缩后 < 500KB(可用 tinypng.com)

**拍摄工具**:
- Windows:Win + Shift + S(截图)或 ShareX
- 浏览器:DevTools → Toggle device toolbar → 截图

## 提交方式

拍好后放入此目录,文件名 `before-after.png`,然后:

```bash
git add docs/before-after.png
git commit -m "docs: add before/after screenshot"
git push
```

README 中的占位文字会自动替换为图片。
