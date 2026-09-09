# Changelog

## [Unreleased]

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
