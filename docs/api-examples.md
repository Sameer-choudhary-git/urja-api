# API response examples

Real responses from `npm run dev:offline` (the real server against the fake
portal). Meter, network and transformer data come from the real export;
**energy readings and transformer capacities are synthetic** in offline mode.
Lists are cut to 2 items (`"... N more"`). Every field is described in
`openapi.json` and at `/docs`.

### `GET /health` → 200

```json
{
  "status": "ok",
  "uptimeSeconds": 0
}
```

### `GET /ready` → 200

```json
{
  "ready": true,
  "portal": {
    "circuit": "closed",
    "consecutiveFailures": 0,
    "retryAfterSeconds": null,
    "activeRequests": 0,
    "queuedRequests": 0
  },
  "catalog": {
    "loaded": true,
    "meterCount": 403,
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "refreshing": false,
    "lastError": null
  }
}
```

### `GET /v1/meters?status=installed&limit=2` → 200

```json
{
  "data": [
    {
      "id": "J100001",
      "serialNumber": "GE84132",
      "make": "L&T",
      "phase": "single",
      "status": "installed",
      "installationType": "ct_operated",
      "build": "legacy",
      "location": {
        "lat": 26.822136543835608,
        "lng": 75.90718190602279
      },
      "network": {
        "zone": {
          "code": "Z-02",
          "name": "Jaipur Zone 2"
        },
        "circle": {
          "code": "C-02",
          "name": "Circle 2"
        },
        "division": {
          "code": "D-02",
          "name": "Division 2"
        },
        "subdivision": {
          "code": "SD-02",
          "name": "Subdivision 2"
        },
        "substation": {
          "code": "SS-02",
          "name": "Substation 2"
        },
        "feeder": {
          "code": "F-002",
          "name": "Feeder 2"
        },
        "transformer": {
          "code": "DT-002",
          "name": "Mansarovar DT 2"
        },
        "path": "Z-02.C-02.D-02.SD-02.SS-02.F-002.DT-002"
      },
      "issues": []
    },
    {
      "id": "J100002",
      "serialNumber": "AL28136",
      "make": "L&T",
      "phase": "single",
      "status": "installed",
      "installationType": "ct_operated",
      "build": "legacy",
      "location": {
        "lat": 26.840224163401967,
        "lng": 75.71461868999545
      },
      "network": {
        "zone": {
          "code": "Z-03",
          "name": "Jaipur Zone 3"
        },
        "circle": {
          "code": "C-03",
          "name": "Circle 3"
        },
        "division": {
          "code": "D-03",
          "name": "Division 3"
        },
        "subdivision": {
          "code": "SD-03",
          "name": "Subdivision 3"
        },
        "substation": {
          "code": "SS-03",
          "name": "Substation 3"
        },
        "feeder": {
          "code": "F-003",
          "name": "Feeder 3"
        },
        "transformer": {
          "code": "DT-003",
          "name": "Vaishali DT 3"
        },
        "path": "Z-03.C-03.D-03.SD-03.SS-03.F-003.DT-003"
      },
      "issues": []
    }
  ],
  "page": {
    "total": 238,
    "limit": 2,
    "offset": 0
  },
  "facets": {
    "make": {
      "L&T": 38,
      "Genus": 49,
      "Allied": 47,
      "HPL": 46,
      "Secure": 58
    },
    "status": {
      "installed": 238
    },
    "phase": {
      "single": 172,
      "three": 66
    },
    "installationType": {
      "ct_operated": 127,
      "whole_current": 111
    },
    "build": {
      "legacy": 136,
      "v2": 102
    }
  },
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/meters/J100400` → 200

```json
{
  "data": {
    "id": "J100400",
    "serialNumber": "GN31592",
    "make": "Genus",
    "phase": "three",
    "status": "installed",
    "installationType": "ct_operated",
    "build": "legacy",
    "location": {
      "lat": 26.882703003792653,
      "lng": 75.74015781362327
    },
    "network": {
      "zone": {
        "code": "Z-01",
        "name": "Jaipur Zone 1"
      },
      "circle": {
        "code": "C-01",
        "name": "Circle 1"
      },
      "division": {
        "code": "D-07",
        "name": "Division 7"
      },
      "subdivision": {
        "code": "SD-07",
        "name": "Subdivision 7"
      },
      "substation": {
        "code": "SS-07",
        "name": "Substation 7"
      },
      "feeder": {
        "code": "F-007",
        "name": "Feeder 7"
      },
      "transformer": {
        "code": "DT-007",
        "name": "Sanganer DT 7"
      },
      "path": "Z-01.C-01.D-07.SD-07.SS-07.F-007.DT-007"
    },
    "issues": [
      {
        "code": "transformer_name_conflict",
        "field": "network.transformer",
        "detail": "Portal export calls it \"Old Malviya Nagar Xfmr\"; canonical name is \"Sanganer DT 7\""
      }
    ],
    "transformer": {
      "code": "DT-007",
      "name": "Sanganer DT 7",
      "aliases": [
        "Old Malviya Nagar Xfmr"
      ],
      "capacityKva": 160,
      "feederCode": "F-007",
      "networkPath": "Z-01.C-01.D-07.SD-07.SS-07.F-007.DT-007",
      "meterCount": 13
    }
  },
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/meters.geojson?limit=1` → 200

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "id": "J100000",
      "geometry": {
        "type": "Point",
        "coordinates": [
          75.83095696146852,
          26.938961002479868
        ]
      },
      "properties": {
        "status": "decommissioned",
        "make": "HPL",
        "phase": "single",
        "transformer": "DT-001",
        "hasIssues": false
      }
    },
    {
      "type": "Feature",
      "id": "J100001",
      "geometry": {
        "type": "Point",
        "coordinates": [
          75.90718190602279,
          26.822136543835608
        ]
      },
      "properties": {
        "status": "installed",
        "make": "L&T",
        "phase": "single",
        "transformer": "DT-002",
        "hasIssues": false
      }
    },
    "... 401 more"
  ]
}
```

### `GET /v1/meters/nearby?lat=26.9124&lng=75.7873&radiusM=5000&limit=2` → 200

```json
{
  "data": [
    {
      "distanceM": 558.2,
      "meter": {
        "id": "J100368",
        "serialNumber": "L&37528",
        "make": "HPL",
        "phase": "three",
        "status": "faulty",
        "installationType": "whole_current",
        "build": "legacy",
        "location": {
          "lat": 26.916888334176132,
          "lng": 75.78477906508856
        },
        "network": {
          "zone": {
            "code": "Z-03",
            "name": "Jaipur Zone 3"
          },
          "circle": {
            "code": "C-03",
            "name": "Circle 3"
          },
          "division": {
            "code": "D-09",
            "name": "Division 9"
          },
          "subdivision": {
            "code": "SD-09",
            "name": "Subdivision 9"
          },
          "substation": {
            "code": "SS-09",
            "name": "Substation 9"
          },
          "feeder": {
            "code": "F-009",
            "name": "Feeder 9"
          },
          "transformer": {
            "code": "DT-009",
            "name": "Sikar Road DT 9"
          },
          "path": "Z-03.C-03.D-09.SD-09.SS-09.F-009.DT-009"
        },
        "issues": []
      }
    },
    {
      "distanceM": 1362.6,
      "meter": {
        "id": "J100238",
        "serialNumber": "L&96401",
        "make": "Secure",
        "phase": "three",
        "status": "installed",
        "installationType": "whole_current",
        "build": "v2",
        "location": {
          "lat": 26.90296465411559,
          "lng": 75.7785314368994
        },
        "network": {
          "zone": {
            "code": "Z-03",
            "name": "Jaipur Zone 3"
          },
          "circle": {
            "code": "C-03",
            "name": "Circle 3"
          },
          "division": {
            "code": "D-09",
            "name": "Division 9"
          },
          "subdivision": {
            "code": "SD-11",
            "name": "Subdivision 11"
          },
          "substation": {
            "code": "SS-03",
            "name": "Substation 3"
          },
          "feeder": {
            "code": "F-011",
            "name": "Feeder 11"
          },
          "transformer": {
            "code": "DT-039",
            "name": "Sikar Road DT 39"
          },
          "path": "Z-03.C-03.D-09.SD-11.SS-03.F-011.DT-039"
        },
        "issues": []
      }
    }
  ],
  "center": {
    "lat": 26.9124,
    "lng": 75.7873
  },
  "radiusM": 5000,
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/meters/J100013/readings?from=2026-06-29&to=2026-06-29&granularity=hour` → 200

```json
{
  "data": {
    "meterId": "J100013",
    "granularity": "hour",
    "timezone": "+05:30",
    "window": {
      "from": "2026-06-29T00:00:00+05:30",
      "to": "2026-06-30T00:00:00+05:30"
    },
    "summary": {
      "intervals": 48,
      "expectedIntervals": 48,
      "totalKwh": 17.26,
      "totalKvah": 18.87,
      "powerFactor": 0.9147,
      "voltageR": {
        "min": 218,
        "avg": 227.1,
        "max": 236
      },
      "peak": {
        "intervalStart": "2026-06-29T12:00:00+05:30",
        "kwh": 0.55
      },
      "firstReadingAt": "2026-06-29T00:30:00+05:30",
      "lastReadingAt": "2026-06-30T00:00:00+05:30"
    },
    "items": [
      {
        "start": "2026-06-29T00:00:00+05:30",
        "end": "2026-06-29T01:00:00+05:30",
        "kwh": 0.59,
        "kvah": 0.66,
        "powerFactor": 0.8939,
        "voltageR": {
          "min": 227,
          "avg": 228.5,
          "max": 230
        },
        "intervals": 2,
        "expectedIntervals": 2,
        "complete": true
      },
      {
        "start": "2026-06-29T01:00:00+05:30",
        "end": "2026-06-29T02:00:00+05:30",
        "kwh": 0.6,
        "kvah": 0.67,
        "powerFactor": 0.8955,
        "voltageR": {
          "min": 233,
          "avg": 234.5,
          "max": 236
        },
        "intervals": 2,
        "expectedIntervals": 2,
        "complete": true
      },
      "... 22 more"
    ],
    "issues": []
  },
  "meta": {
    "asOf": "2026-11-03T17:03:59.042Z",
    "ageSeconds": 0,
    "stale": false,
    "cache": "miss",
    "maxAgeSeconds": 3600,
    "latestReadingAt": "2026-06-30T23:30:00+05:30"
  }
}
```

### `GET /v1/meters/J100013/readings?from=2026-06-29T10:00&to=2026-06-29T11:00` → 200

```json
{
  "data": {
    "meterId": "J100013",
    "granularity": "raw",
    "timezone": "+05:30",
    "window": {
      "from": "2026-06-29T10:00:00+05:30",
      "to": "2026-06-29T11:00:00+05:30"
    },
    "summary": {
      "intervals": 2,
      "expectedIntervals": 2,
      "totalKwh": 0.99,
      "totalKvah": 1.02,
      "powerFactor": 0.9706,
      "voltageR": {
        "min": 224,
        "avg": 225.5,
        "max": 227
      },
      "peak": {
        "intervalStart": "2026-06-29T10:00:00+05:30",
        "kwh": 0.52
      },
      "firstReadingAt": "2026-06-29T10:30:00+05:30",
      "lastReadingAt": "2026-06-29T11:00:00+05:30"
    },
    "items": [
      {
        "timestamp": "2026-06-29T10:30:00+05:30",
        "intervalStart": "2026-06-29T10:00:00+05:30",
        "kwhRegister": 20557.99,
        "kvahRegister": 22209.4,
        "voltageR": 224,
        "intervalKwh": 0.52,
        "intervalKvah": 0.54,
        "powerFactor": 0.963
      },
      {
        "timestamp": "2026-06-29T11:00:00+05:30",
        "intervalStart": "2026-06-29T10:30:00+05:30",
        "kwhRegister": 20558.46,
        "kvahRegister": 22209.88,
        "voltageR": 227,
        "intervalKwh": 0.47,
        "intervalKvah": 0.48,
        "powerFactor": 0.9792
      }
    ],
    "issues": []
  },
  "meta": {
    "asOf": "2026-11-03T17:03:59.056Z",
    "ageSeconds": 0,
    "stale": false,
    "cache": "miss",
    "maxAgeSeconds": 3600,
    "latestReadingAt": "2026-06-29T23:30:00+05:30"
  }
}
```

### `GET /v1/meters/J100000/anomalies?from=2026-06-24&to=2026-06-30` → 200

```json
{
  "data": {
    "meterId": "J100000",
    "window": {
      "from": "2026-06-24T00:00:00+05:30",
      "to": "2026-07-01T00:00:00+05:30"
    },
    "anomalies": [
      {
        "code": "decommissioned_but_consuming",
        "severity": "critical",
        "subject": "J100000",
        "at": "2026-06-24T00:30:00+05:30",
        "message": "Marked decommissioned, but recorded 118.35 kWh in this window",
        "value": 118.35
      },
      {
        "code": "data_gap",
        "severity": "info",
        "subject": "J100000",
        "at": null,
        "message": "1 of 336 half hours have no usage figure",
        "value": 1
      }
    ]
  },
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/anomalies?transformer=DT-007&from=2026-06-24&to=2026-06-30` → 200

```json
{
  "data": {
    "scope": "transformer DT-007",
    "metersScanned": 13,
    "failed": [],
    "counts": {
      "bySeverity": {
        "critical": 2,
        "info": 21
      },
      "byCode": {
        "decommissioned_but_consuming": 2,
        "data_gap": 13,
        "consumption_spike": 8
      }
    },
    "anomalies": [
      {
        "code": "decommissioned_but_consuming",
        "severity": "critical",
        "subject": "J100006",
        "at": "2026-06-24T00:30:00+05:30",
        "message": "Marked decommissioned, but recorded 119.14 kWh in this window",
        "value": 119.14
      },
      {
        "code": "decommissioned_but_consuming",
        "severity": "critical",
        "subject": "J100046",
        "at": "2026-06-24T00:30:00+05:30",
        "message": "Marked decommissioned, but recorded 123.84 kWh in this window",
        "value": 123.84
      },
      "... 21 more"
    ]
  },
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/transformers?limit=2` → 200

```json
{
  "data": [
    {
      "code": "DT-001",
      "name": "Malviya Nagar DT 1",
      "aliases": [],
      "capacityKva": 100,
      "feederCode": "F-001",
      "networkPath": "Z-01.C-01.D-01.SD-01.SS-01.F-001.DT-001",
      "meterCount": 10
    },
    {
      "code": "DT-002",
      "name": "Mansarovar DT 2",
      "aliases": [],
      "capacityKva": 160,
      "feederCode": "F-002",
      "networkPath": "Z-02.C-02.D-02.SD-02.SS-02.F-002.DT-002",
      "meterCount": 10
    }
  ],
  "page": {
    "total": 40,
    "limit": 2,
    "offset": 0
  },
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/transformers/DT-007` → 200

```json
{
  "data": {
    "code": "DT-007",
    "name": "Sanganer DT 7",
    "aliases": [
      "Old Malviya Nagar Xfmr"
    ],
    "capacityKva": 160,
    "feederCode": "F-007",
    "networkPath": "Z-01.C-01.D-07.SD-07.SS-07.F-007.DT-007",
    "meterCount": 13,
    "statusCounts": {
      "decommissioned": 2,
      "installed": 8,
      "faulty": 3
    },
    "meters": [
      {
        "id": "J100006",
        "serialNumber": "SE35634",
        "make": "HPL",
        "phase": "single",
        "status": "decommissioned"
      },
      {
        "id": "J100046",
        "serialNumber": "AL11788",
        "make": "Secure",
        "phase": "single",
        "status": "decommissioned"
      },
      "... 11 more"
    ]
  },
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/transformers/DT-007/load?from=2026-06-29&to=2026-06-29` → 200

```json
{
  "data": {
    "transformer": {
      "code": "DT-007",
      "name": "Sanganer DT 7",
      "aliases": [
        "Old Malviya Nagar Xfmr"
      ],
      "capacityKva": 160,
      "feederCode": "F-007",
      "networkPath": "Z-01.C-01.D-07.SD-07.SS-07.F-007.DT-007",
      "meterCount": 13
    },
    "window": {
      "from": "2026-06-29T00:00:00+05:30",
      "to": "2026-06-30T00:00:00+05:30"
    },
    "capacityKva": 160,
    "peak": {
      "intervalStart": "2026-06-29T11:00:00+05:30",
      "kva": 17.98,
      "metersReporting": 13
    },
    "peakUtilisationPercent": 11.2,
    "averageKva": 12.382,
    "metersReporting": 13,
    "failed": [],
    "points": [
      {
        "intervalStart": "2026-06-29T00:00:00+05:30",
        "kva": 9.68,
        "metersReporting": 13
      },
      {
        "intervalStart": "2026-06-29T00:30:00+05:30",
        "kva": 9.68,
        "metersReporting": 13
      },
      "... 46 more"
    ],
    "anomalies": []
  },
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/hierarchy?depth=2` → 200

```json
{
  "data": [
    {
      "id": "Z-01",
      "level": "zone",
      "code": "Z-01",
      "name": "Jaipur Zone 1",
      "meterCount": 143,
      "statusCounts": {
        "decommissioned": 26,
        "installed": 89,
        "faulty": 28
      },
      "children": [
        {
          "id": "Z-01.C-01",
          "level": "circle",
          "code": "C-01",
          "name": "Circle 1",
          "meterCount": 73,
          "statusCounts": {
            "decommissioned": 18,
            "installed": 41,
            "faulty": 14
          }
        },
        {
          "id": "Z-01.C-04",
          "level": "circle",
          "code": "C-04",
          "name": "Circle 4",
          "meterCount": 70,
          "statusCounts": {
            "installed": 48,
            "decommissioned": 8,
            "faulty": 14
          }
        }
      ]
    },
    {
      "id": "Z-02",
      "level": "zone",
      "code": "Z-02",
      "name": "Jaipur Zone 2",
      "meterCount": 130,
      "statusCounts": {
        "installed": 78,
        "faulty": 29,
        "decommissioned": 23
      },
      "children": [
        {
          "id": "Z-02.C-02",
          "level": "circle",
          "code": "C-02",
          "name": "Circle 2",
          "meterCount": 70,
          "statusCounts": {
            "installed": 42,
            "decommissioned": 13,
            "faulty": 15
          }
        },
        {
          "id": "Z-02.C-05",
          "level": "circle",
          "code": "C-05",
          "name": "Circle 5",
          "meterCount": 60,
          "statusCounts": {
            "faulty": 14,
            "installed": 36,
            "decommissioned": 10
          }
        }
      ]
    },
    "... 1 more"
  ],
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/hierarchy/Z-01.C-01` → 200

```json
{
  "data": {
    "id": "Z-01.C-01",
    "level": "circle",
    "code": "C-01",
    "name": "Circle 1",
    "meterCount": 73,
    "statusCounts": {
      "decommissioned": 18,
      "installed": 41,
      "faulty": 14
    },
    "breadcrumb": [
      {
        "id": "Z-01",
        "level": "zone",
        "code": "Z-01",
        "name": "Jaipur Zone 1"
      }
    ],
    "children": [
      {
        "id": "Z-01.C-01.D-01",
        "level": "division",
        "code": "D-01",
        "name": "Division 1",
        "meterCount": 20,
        "statusCounts": {
          "decommissioned": 6,
          "installed": 9,
          "faulty": 5
        }
      },
      {
        "id": "Z-01.C-01.D-03",
        "level": "division",
        "code": "D-03",
        "name": "Division 3",
        "meterCount": 10,
        "statusCounts": {
          "installed": 5,
          "faulty": 3,
          "decommissioned": 2
        }
      },
      "... 3 more"
    ],
    "meters": [
      {
        "id": "J100000",
        "serialNumber": "SE33962",
        "make": "HPL",
        "phase": "single",
        "status": "decommissioned",
        "installationType": "whole_current",
        "build": "legacy",
        "location": {
          "lat": 26.938961002479868,
          "lng": 75.83095696146852
        },
        "network": {
          "zone": {
            "code": "Z-01",
            "name": "Jaipur Zone 1"
          },
          "circle": {
            "code": "C-01",
            "name": "Circle 1"
          },
          "division": {
            "code": "D-01",
            "name": "Division 1"
          },
          "subdivision": {
            "code": "SD-01",
            "name": "Subdivision 1"
          },
          "substation": {
            "code": "SS-01",
            "name": "Substation 1"
          },
          "feeder": {
            "code": "F-001",
            "name": "Feeder 1"
          },
          "transformer": {
            "code": "DT-001",
            "name": "Malviya Nagar DT 1"
          },
          "path": "Z-01.C-01.D-01.SD-01.SS-01.F-001.DT-001"
        },
        "issues": []
      },
      {
        "id": "J100006",
        "serialNumber": "SE35634",
        "make": "HPL",
        "phase": "single",
        "status": "decommissioned",
        "installationType": "whole_current",
        "build": "legacy",
        "location": {
          "lat": 26.812653854983022,
          "lng": 75.80722787903873
        },
        "network": {
          "zone": {
            "code": "Z-01",
            "name": "Jaipur Zone 1"
          },
          "circle": {
            "code": "C-01",
            "name": "Circle 1"
          },
          "division": {
            "code": "D-07",
            "name": "Division 7"
          },
          "subdivision": {
            "code": "SD-07",
            "name": "Subdivision 7"
          },
          "substation": {
            "code": "SS-07",
            "name": "Substation 7"
          },
          "feeder": {
            "code": "F-007",
            "name": "Feeder 7"
          },
          "transformer": {
            "code": "DT-007",
            "name": "Sanganer DT 7"
          },
          "path": "Z-01.C-01.D-07.SD-07.SS-07.F-007.DT-007"
        },
        "issues": []
      },
      "... 48 more"
    ],
    "page": {
      "total": 73,
      "limit": 50,
      "offset": 0
    }
  },
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/search?q=sanganer` → 200

```json
{
  "data": {
    "meters": [],
    "transformers": [
      {
        "code": "DT-007",
        "name": "Sanganer DT 7",
        "aliases": [
          "Old Malviya Nagar Xfmr"
        ]
      },
      {
        "code": "DT-017",
        "name": "Sanganer DT 17",
        "aliases": []
      },
      "... 2 more"
    ],
    "nodes": []
  },
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/stats?groupBy=status` → 200

```json
{
  "data": {
    "meters": 403,
    "transformers": 40,
    "totalCapacityKva": 7784,
    "metersWithIssues": 25,
    "byStatus": {
      "decommissioned": 75,
      "installed": 238,
      "faulty": 90
    },
    "byMake": {
      "HPL": 90,
      "L&T": 64,
      "Genus": 88,
      "Allied": 76,
      "Secure": 85
    },
    "byPhase": {
      "single": 277,
      "three": 126
    },
    "byInstallationType": {
      "whole_current": 205,
      "ct_operated": 198
    },
    "byBuild": {
      "legacy": 238,
      "v2": 165
    },
    "groupedBy": {
      "field": "status",
      "counts": {
        "decommissioned": 75,
        "installed": 238,
        "faulty": 90
      }
    }
  },
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/quality` → 200

```json
{
  "data": {
    "summary": {
      "meters": 403,
      "metersWithIssues": 25,
      "issuesByCode": {
        "network_cell_repaired": 22,
        "transformer_name_conflict": 3
      }
    },
    "transformerNameConflicts": [
      {
        "code": "DT-007",
        "canonicalName": "Sanganer DT 7",
        "aliases": [
          "Old Malviya Nagar Xfmr"
        ]
      }
    ],
    "scan": "{ ... full export scan ... }"
  },
  "meta": {
    "asOf": "2026-11-03T17:03:58.462Z",
    "ageSeconds": 0,
    "stale": false,
    "source": "export"
  }
}
```

### `GET /v1/meters/J999999` → 404

```json
{
  "type": "https://urja-api.local/problems/not-found",
  "title": "Not found",
  "status": 404,
  "code": "not_found",
  "detail": "Meter J999999 does not exist",
  "requestId": "bf05ac8a-a3fc-4a59-9288-0663b304b5d6"
}
```

