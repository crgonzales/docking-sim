# Renderer spike assets

MIT-licensed assets copied from the npm distributions of
`@takram/three-atmosphere@0.19.1` and `@takram/three-clouds@0.7.6`.
STBN is pinned to the upstream commit 9627216cc50057994c98a2118f3c4a23765d43b9:
https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/9627216cc50057994c98a2118f3c4a23765d43b9/packages/core/assets/stbn.bin

Project/license: https://github.com/takram-design-engineering/three-geospatial

The atmosphere LUTs are for AtmosphereParameters.DEFAULT (6360 km bottom,
6420 km top). The spike uses the library's ellipsoid altitude correction for
the simulation's 6371 km sphere. Do not change the LUT parameters without
rebaking them. These assets belong only to the isolated feasibility spike.
