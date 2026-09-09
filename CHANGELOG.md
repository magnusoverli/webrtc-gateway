# Changelog

## [Unreleased]

- Restored full-edge resize targets and two-way cursors while retaining the library's default grip visuals.
- Fixed displaced tiles flickering during continuous resizing by animating only grid-space changes and keeping transitions intact until layout commits.
- Switched tile resize handles to the unmodified react-resizable stylesheet, removing custom corner marks, full-edge hotspots, and resize highlights.
- Simplified multiview title bars by removing status text and the fullscreen entry button; double-click video or press Enter on a focused video to expand it.
- Made the full multiview title bar draggable and removed the separate move-grip icon, while keeping title-bar action buttons independently clickable.
- Replaced custom tile resize dragging with react-resizable, adding visible corner grips for resizing both dimensions together.
- Made multiview tile resizing continuous between grid sizes, with immediate neighbour displacement and saved intermediate dimensions.
- Added browser-saved multiview tile resizing on the 4×3 grid with automatic page reflow, one-click size reset, and double-click fullscreen.
- Added inline channel health with actionable structured issues, retry details, and separately scoped browser observations, without raw logs or extra polling.
- Made multiview drag placeholders invisible and previews level at actual tile size, displacing neighbors only when more than half the preview overlaps them.
- Fixed the move-position dialog sometimes failing to open on a mobile tap immediately after a cross-page drag.
- Fixed short multiview drops snapping neighboring tiles instantly by letting their in-flight sorting animation finish after pointer release.
- Softened neighboring multiview tiles' drag animation with a longer, non-overshooting glide while keeping the pointer preview immediate.
- Added translucent frame-snapshot drag previews and live animated multiview sorting, preserving player sessions and saving order only on drop.
- Convert only SMPTE 302M SRT audio to stereo Opus before MediaMTX, preserving video and other audio with bounded, lossless startup discovery.
- Made multiview audio meters slim, lightly shaded overlays flush with the full-height video surface's right edge, with compact padding and visible mobile labels.
- Fixed multiview meters to overlay discrete L/R bars and a mobile-visible scale, request Opus stereo, and distinguish missing audio from silence without relying on initial track channel counts.
- Removed native multiview player controls and added silent per-channel dBFS audio meters with peak hold and near-full-scale indicators.
- Added an Open multiviewer overview button and a cleaner multiview toolbar with an Overview breadcrumb and on-demand help.
- Added a fixed 3-by-4 multiview with 12 channels per page, drag-and-drop ordering, and browser-saved layouts.
- Added an overview Links & embeds dialog with copyable WebRTC viewer URLs and iframe code for every channel and the multiviewer.
- Fixed keyboard focus returning to the opening control after a dialog closes.
- Improved Global settings dialog scaling, stacked-field spacing, help visibility, and long interface selection on narrow or short screens.
