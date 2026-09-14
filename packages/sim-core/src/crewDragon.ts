import type { ThrusterSpec } from './thrusters.js';

/** Artist-model registration, not manufacturer flight data. Coordinates are
 * measured from KUBAHA's CC-BY-4.0 Dragon 2 mesh (see assets/ASSETS.md).
 * +Y is docking-forward; force is opposite each modeled exhaust opening.
 * Keep the demo's 25 N thrust/mass tuning; this is not a flight-certified Dragon.
 */
export const CREW_DRAGON_SCALE = 3.7 / 0.4;
export const CREW_DRAGON_DOCK_SOURCE_Y = 0.44686123728752136;
export const CREW_DRAGON_OFFSET_Y = 1.7 - CREW_DRAGON_DOCK_SOURCE_Y * CREW_DRAGON_SCALE;
export const CREW_DRAGON_THRUSTERS: readonly (ThrusterSpec & { nozzleRadiusM: number; sourceComponent: number })[] = [
  {
    "id": "J1",
    "position_body_m": [
      1.027648655,
      -1.002999617,
      1.448917708
    ],
    "direction_body": [
      0.127077231106,
      -0.915936130436,
      -0.380673590227
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.046655731,
    "sourceComponent": 0
  },
  {
    "id": "J2",
    "position_body_m": [
      0.96940665,
      -1.377618666,
      1.565275628
    ],
    "direction_body": [
      0.297565607103,
      0.505138049653,
      -0.810117436093
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.046655871,
    "sourceComponent": 1
  },
  {
    "id": "J3",
    "position_body_m": [
      1.054808018,
      -1.649939151,
      1.541152637
    ],
    "direction_body": [
      0.034394829288,
      0.851296172629,
      -0.523556894888
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.046655932,
    "sourceComponent": 2
  },
  {
    "id": "J4",
    "position_body_m": [
      -1.027649012,
      -1.002999683,
      1.448917583
    ],
    "direction_body": [
      -0.127077586615,
      -0.915935571807,
      -0.380674815661
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.046655674,
    "sourceComponent": 6
  },
  {
    "id": "J5",
    "position_body_m": [
      -0.969406937,
      -1.377618559,
      1.565274654
    ],
    "direction_body": [
      -0.297566846785,
      0.505139280444,
      -0.810116213297
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.04665574,
    "sourceComponent": 7
  },
  {
    "id": "J6",
    "position_body_m": [
      -1.054808822,
      -1.64993876,
      1.54115104
    ],
    "direction_body": [
      -0.034393936371,
      0.851297630041,
      -0.523554583809
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.046655629,
    "sourceComponent": 8
  },
  {
    "id": "J7",
    "position_body_m": [
      1.027649121,
      -1.002999654,
      -1.448918473
    ],
    "direction_body": [
      0.127077479614,
      -0.915935612609,
      0.380674753208
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.046655833,
    "sourceComponent": 3
  },
  {
    "id": "J8",
    "position_body_m": [
      0.969407365,
      -1.377618386,
      -1.565275724
    ],
    "direction_body": [
      0.297565563549,
      0.505138094474,
      0.810117424144
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.046655786,
    "sourceComponent": 9
  },
  {
    "id": "J9",
    "position_body_m": [
      1.05480866,
      -1.649938935,
      -1.54115302
    ],
    "direction_body": [
      0.034394708021,
      0.851296142516,
      0.523556951818
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.046655764,
    "sourceComponent": 10
  },
  {
    "id": "J10",
    "position_body_m": [
      -1.027648429,
      -1.002999714,
      -1.448918685
    ],
    "direction_body": [
      -0.127077265186,
      -0.915935673054,
      0.380674679353
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.046655735,
    "sourceComponent": 11
  },
  {
    "id": "J11",
    "position_body_m": [
      -0.969406384,
      -1.377618914,
      -1.565276347
    ],
    "direction_body": [
      -0.2975655732,
      0.505139232947,
      0.810116710717
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.046655759,
    "sourceComponent": 12
  },
  {
    "id": "J12",
    "position_body_m": [
      -1.054807976,
      -1.649938799,
      -1.541151919
    ],
    "direction_body": [
      -0.034394531397,
      0.85129791953,
      0.523554074011
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.046655955,
    "sourceComponent": 13
  },
  {
    "id": "J13",
    "position_body_m": [
      0.5264286,
      1.49807863,
      -0.357010225
    ],
    "direction_body": [
      -0.0,
      -1.0,
      -0.0
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.0635216,
    "sourceComponent": 18
  },
  {
    "id": "J14",
    "position_body_m": [
      0.5264286,
      1.49807863,
      0.35699265
    ],
    "direction_body": [
      -0.0,
      -1.0,
      -0.0
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.0635216,
    "sourceComponent": 19
  },
  {
    "id": "J15",
    "position_body_m": [
      -0.526427675,
      1.49807863,
      -0.357010225
    ],
    "direction_body": [
      -0.0,
      -1.0,
      -0.0
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.0635216,
    "sourceComponent": 20
  },
  {
    "id": "J16",
    "position_body_m": [
      -0.526427675,
      1.49807863,
      0.35699265
    ],
    "direction_body": [
      -0.0,
      -1.0,
      -0.0
    ],
    "thrust_N": 25,
    "nozzleRadiusM": 0.0635216,
    "sourceComponent": 21
  }
];
