'use strict';

// Pinned official seller contracts; regenerate with scripts/generate-lazada-api-contracts.cjs.
module.exports = {
  "documentation_snapshot": "2026-09-30",
  "scope": "Official seller-grant merchant operations and public category/warehouse reads, on the six existing production country endpoints. Separate identities and host consent workflows are unavailable, not callable actions.",
  "methods": {
    "GET /shop/follow/status/batch/query": {
      "id": 1281,
      "path": "/shop/follow/status/batch/query",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "BatchQueryFollowStatus: Query whether these customers follow this seller. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fshop%2Ffollow%2Fstatus%2Fbatch%2Fquery",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "buyer_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "buyerId array"
                },
                "maxItems": 100,
                "description": "buyerId array"
              }
            },
            "required": [
              "buyer_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /rc/store/list/get": {
      "id": 1322,
      "path": "/rc/store/list/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetPickUpStoreList: return the list of pick up store infomation for requested Seller Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Frc%2Fstore%2Flist%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /seller/get": {
      "id": 1346,
      "path": "/seller/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetSeller: Get seller information by current seller ID. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fseller%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /seller/metrics/get": {
      "id": 1339,
      "path": "/seller/metrics/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetSellerMetricsById: Provide seller metrics data of the specific seller, like positive seller rating, ship on time rate and etc. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fseller%2Fmetrics%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /seller/performance/get": {
      "id": 1323,
      "path": "/seller/performance/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetSellerPerformance: Provide the performance metrics of the current seller, such as positive seller rating, ship on time, etc. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fseller%2Fperformance%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "language": {
                "type": "string",
                "maxLength": 262144,
                "description": "Optional ISO 639-1 standard language code (default: en-US, supported languages: en-US, zh-CN, ms-MY, th-TH, vi-VN, id-ID)."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /rc/warehouse/get": {
      "id": 1327,
      "path": "/rc/warehouse/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetWarehouseBySellerId: get warehouse by seller id Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Frc%2Fwarehouse%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "not_success"
          ],
          "name": "not_success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /rc/warehouse/detail/get": {
      "id": 1329,
      "path": "/rc/warehouse/detail/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "QueryWarehouseDetailInfoBySellerId: query warehouse detail info by seller id Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Frc%2Fwarehouse%2Fdetail%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "not_success"
          ],
          "name": "not_success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /rc/sellerWarehouse/saveWarehouseInfo": {
      "id": 2058,
      "path": "/rc/sellerWarehouse/saveWarehouseInfo",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "saveSellerWarehouseInfo: Api to create or edit the seller warehouse info except the \"default\" dropshipping warehouse and the return warehouse. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Frc%2FsellerWarehouse%2FsaveWarehouseInfo",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "ownerType": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "the fixed value is 0",
                "const": 0
              },
              "sellerId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "seller id"
              },
              "warehouseOwnerType": {
                "type": "string",
                "maxLength": 262144,
                "description": "the fixed value is SELLER",
                "const": "SELLER"
              },
              "warehouseContactDTO": {
                "type": "object",
                "properties": {
                  "phoneNumber": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "phone"
                  },
                  "email": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "email"
                  }
                },
                "required": [
                  "phoneNumber",
                  "email"
                ],
                "additionalProperties": false,
                "description": "address info"
              },
              "siteId": {
                "type": "string",
                "maxLength": 262144,
                "description": "site id"
              },
              "warehouseAddressInfoDTO": {
                "type": "object",
                "properties": {
                  "locationLevel2Label": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "province"
                  },
                  "address": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "address detail"
                  },
                  "locationLevel4Label": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "district"
                  },
                  "locationLevel3Label": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "city"
                  },
                  "postalCode": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "postal code"
                  },
                  "latitude": {
                    "type": "number",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991,
                    "description": "latitude"
                  },
                  "countryIosCode": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "currencyCode"
                  },
                  "defaultAddress": {
                    "type": "number",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991,
                    "description": "the fixed value is 0",
                    "const": 0
                  },
                  "longitude": {
                    "type": "number",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991,
                    "description": "longitude"
                  }
                },
                "required": [
                  "locationLevel2Label",
                  "address",
                  "locationLevel4Label",
                  "locationLevel3Label",
                  "postalCode",
                  "countryIosCode",
                  "defaultAddress"
                ],
                "additionalProperties": false,
                "description": "address info"
              },
              "warehouseType": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "the fixed value is 200",
                "const": 200
              },
              "ownerId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "seller id"
              },
              "warehouseName": {
                "type": "string",
                "maxLength": 262144,
                "description": "warehouse name"
              },
              "currencyCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "currency code"
              },
              "resourceType": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "resourceType - the fixed value is 1.",
                "const": 1
              }
            },
            "required": [
              "ownerType",
              "sellerId",
              "warehouseOwnerType",
              "warehouseContactDTO",
              "siteId",
              "warehouseAddressInfoDTO",
              "warehouseType",
              "ownerId",
              "warehouseName",
              "currencyCode",
              "resourceType"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "not_success"
          ],
          "name": "not_success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sellercenter/msg/list": {
      "id": 2093,
      "path": "/sellercenter/msg/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "SellerCenterMsgList: seller center msg box Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsellercenter%2Fmsg%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "language": {
                "type": "string",
                "maxLength": 262144,
                "description": "Set the language for returned messages.(en/vn/id/sg/ph...)"
              },
              "page": {
                "type": "string",
                "maxLength": 262144,
                "description": "Paged query."
              },
              "pageSize": {
                "type": "string",
                "maxLength": 262144,
                "description": "Paged query, with a maximum return of one hundred records."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /seller/policy/fetch": {
      "id": 1324,
      "path": "/seller/policy/fetch",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "SellerPolicyFetch: Fetch seller policy information Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fseller%2Fpolicy%2Ffetch",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "locale": {
                "type": "string",
                "maxLength": 262144,
                "description": "locale"
              }
            },
            "required": [
              "locale"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /product/stock/sellable/adjust": {
      "id": 977,
      "path": "/product/stock/sellable/adjust",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "AdjustSellableQuantity: Use this API to increase or decrease sellable quantity of one or more existing products. The maximum number of products that can be updated is 50, but 20 is recommended. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fstock%2Fsellable%2Fadjust",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "Please take demo as reference."
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "POST /size/chart/batch/update": {
      "id": 1966,
      "path": "/size/chart/batch/update",
      "method": "POST",
      "risk": "W",
      "multipart": false,
      "description": "BatchUpdateSizeChart: 批量更新尺码表 Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsize%2Fchart%2Fbatch%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "product size chart"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "POST /product/create": {
      "id": 950,
      "path": "/product/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateProduct: Use this API to create a single new product. Find more details below: https://open.lazada.com/apps/doc/doc?nodeId=30720&docId=120949 Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "Parameter description"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "POST /product/deactivate": {
      "id": 1296,
      "path": "/product/deactivate",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "DeactivateProduct: Use this API to deactivate Product or SKUs corresponding to the product Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fdeactivate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "apiRequestBody": {
                "type": "string",
                "maxLength": 262144,
                "description": "Parameter ItemId is mandatory, Skus is optional"
              }
            },
            "required": [
              "apiRequestBody"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /category/brands/query": {
      "id": 1286,
      "path": "/category/brands/query",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetBrandByPages: Use this API to retrieve all product brands by page index in the system. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fcategory%2Fbrands%2Fquery",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "startRow": {
                "type": "string",
                "maxLength": 262144,
                "description": "Number of brands to skip (i.e., an offset into the result set; together with the \"limit\" parameter, simple result set paging is possible; if you do page through results, note that the list of brands might change during paging)."
              },
              "pageSize": {
                "type": "string",
                "maxLength": 262144,
                "description": "The maximum number of brands that can be returned. If you omit this parameter, the default of 40 is used. The Maximum is 200."
              }
            },
            "required": [
              "startRow",
              "pageSize"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /category/attributes/get": {
      "id": 1282,
      "path": "/category/attributes/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetCategoryAttributes: Use this API to get a list of attributes for a specified product category. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fcategory%2Fattributes%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "primary_category_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "identifiers of category code"
              },
              "language_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Language code indicates the type of language you would like to translate. Please note not all languages are available in every region. For example, in Indonesia, only English and Indonesia are available. If you are passing a language code which does not belong to your area, null value might receive. Please do make sure your language code is correct. Supported language codes are listed as below: English:\"en_US\" - available in every area Singapore:\"en_SG\" - available in Singapore Thailand\"th_TH\" - available in Thailand Indonesia:\"id_ID\" - available in Indonesia Vietnam:\"vi_VN\" - available in Vietnam Philippines: \"fil_PH\" - available in Philippines Malaysia : \"ms_MY\" - available in Malaysia Default(if null is passed): \"en_US\""
              }
            },
            "required": [
              "primary_category_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /product/category/suggestion/get": {
      "id": 1292,
      "path": "/product/category/suggestion/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetCategorySuggestion: Get product's category suggestion by product title Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fcategory%2Fsuggestion%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "product_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product Name"
              },
              "image_url": {
                "type": "string",
                "maxLength": 262144,
                "description": "image url"
              }
            },
            "required": [
              "product_name",
              "image_url"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /category/tree/get": {
      "id": 1303,
      "path": "/category/tree/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetCategoryTree: Use this API to retrieve the list of all product categories in the system. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fcategory%2Ftree%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "language_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Language code indicates the type of language you would like to translate. Please note not all languages are available in every region. For example, in Indonesia, only English and Indonesia are available. If you are passing a language code which does not belong to your area, null value might receive. Please do make sure your language code is correct. Supported language codes are listed as below: English:\"en_US\" - available in every area Singapore:\"en_SG\" - available in Singapore Thailand\"th_TH\" - available in Thailand Indonesia:\"id_ID\" - available in Indonesia Vietnam:\"vi_VN\" - available in Vietnam Philippines: \"fil_PH\" - available in Philippines Malaysia : \"ms_MY\" - available in Malaysia Default(if null is passed): \"en_US\""
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /category/cascade/getNextCascadeProp": {
      "id": 1657,
      "path": "/category/cascade/getNextCascadeProp",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetNextCascadeProp: Use this API to query next cascade prop. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fcategory%2Fcascade%2FgetNextCascadeProp",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "categoryId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Category id"
              },
              "cascadeId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Cascade id. Query from https://open.lazada.com/apps/doc/api?path=%2Fcategory%2Fattributes%2Fget"
              },
              "path": {
                "type": "string",
                "maxLength": 262144,
                "description": "current cascade property path"
              }
            },
            "required": [
              "categoryId",
              "cascadeId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /product/seller/item/getPreQcRules": {
      "id": 1530,
      "path": "/product/seller/item/getPreQcRules",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetPreQcRules: query pre qc rules Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fseller%2Fitem%2FgetPreQcRules",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "option": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "query qc option"
              },
              "option_set": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "query qc rules option.[1] return item limit, [2] return restricted category id, [1,2] return both"
                },
                "maxItems": 100,
                "description": "query qc rules option.[1] return item limit, [2] return restricted category id, [1,2] return both"
              }
            },
            "required": [
              "option",
              "option_set"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "values",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /product/content/score/get": {
      "id": 1855,
      "path": "/product/content/score/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetProductContentScore: get product content score Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fcontent%2Fscore%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "item_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Call this API; \"Item Id\" must be selected as the request parameter."
              }
            },
            "required": [
              "item_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /product/item/get": {
      "id": 1313,
      "path": "/product/item/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetProductItem: Get single product by ItemId or SellerSku. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fitem%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "item_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Call this API; \"Item Id\" must be selected as the request parameter"
              },
              "seller_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "The parameter has been deprecated and is no longer supported after November 15th, 2023."
              }
            },
            "required": [
              "item_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /products/get": {
      "id": 1301,
      "path": "/products/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetProducts: Use this API to get detailed information of the specified products. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproducts%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "filter": {
                "type": "string",
                "maxLength": 262144,
                "description": "Returns the products with the status matching this parameter. Possible values are all, live, inactive, deleted, pending, rejected, sold-out. Mandatory."
              },
              "update_before": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned product list to those updated before or on a specified date, given in ISO 8601 date format. Optional"
              },
              "create_before": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned products to those created before or on the specified date, given in ISO 8601 date format. Optional"
              },
              "offset": {
                "type": "string",
                "maxLength": 262144,
                "description": "Deprecated(The number of Items you want to skip before you start counting),It is recommended to use date for scrolling query.The maximum offset is 10000"
              },
              "create_after": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned products to those created after or on the specified date, given in ISO 8601 date format. Optional"
              },
              "update_after": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned products to those updated after or on the specified date, given in ISO 8601 date format. Optional"
              },
              "limit": {
                "type": "string",
                "maxLength": 262144,
                "description": "The number of Items you would like to fetch from every response,The maximum is 50."
              },
              "options": {
                "type": "string",
                "maxLength": 262144,
                "description": "This value can be used to get more stock information. e.g., Options=1 means contain ReservedStock, RtsStock, PendingStock, RealTimeStock, FulfillmentBySellable."
              },
              "sku_seller_list": {
                "type": "string",
                "maxLength": 262144,
                "description": "Only products that have the Seller SKU in this list will be returned. Input should be a JSON array. For example, [\"Apple 6S Gold\", \"Apple 6S Black\"]. It only matches the whole words. A maximum of 100 SKUs can be returned."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /product/qc/alert/list": {
      "id": 1650,
      "path": "/product/qc/alert/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetQCAlertProducts: Getting seller's products that have been alerted by quality control. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fqc%2Falert%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "offset": {
                "type": "string",
                "maxLength": 262144,
                "description": "Number of QC alert products to skip"
              },
              "limit": {
                "type": "string",
                "maxLength": 262144,
                "description": "The maximum number of QC alert products that can be returned."
              }
            },
            "required": [
              "offset",
              "limit"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /image/response/get": {
      "id": 1300,
      "path": "/image/response/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetResponse: Use this API to get the returned information from the system for the MigrateImages API. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fimage%2Fresponse%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "batch_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Request ID from the MigrateImages request"
              }
            },
            "required": [
              "batch_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /product/seller/item/limit": {
      "id": 1299,
      "path": "/product/seller/item/limit",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetSellerItemLimit: The platform will provide the product quantity limit information by this interface. The qps will be limited by seller, 10 qps per seller. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fseller%2Fitem%2Flimit",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "errorCodes",
          "type": "String[]",
          "required": false
        },
        {
          "name": "errorMsgs",
          "type": "String[]",
          "required": false
        },
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /size/chart/template/get": {
      "id": 1967,
      "path": "/size/chart/template/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetSizeChartTemplate: 获取尺码模板列表 Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsize%2Fchart%2Ftemplate%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "template_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "size chart template id"
              },
              "template_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "size chart name"
              },
              "page_no": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page no"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size"
              }
            },
            "required": [
              "page_no",
              "page_size"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /product/unfilled/attribute/get": {
      "id": 1298,
      "path": "/product/unfilled/attribute/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetUnfilledAttributeItem: Get products without key attributes. (For cross boarder sellers Only) Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Funfilled%2Fattribute%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "page_index": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page_index"
              },
              "attribute_tag": {
                "type": "string",
                "maxLength": 262144,
                "description": "The tag of attributes. Currently only has one value \"key_prop\" 属性标示。当前只支持key_prop"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The number of Products you would like to fetch from every response. The max number is 50. 返回的最大商品量。最大值50。商品级别"
              },
              "language_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Multi-language of category attributes that need to be returned"
              }
            },
            "required": [
              "page_index",
              "attribute_tag",
              "page_size",
              "language_code"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "total_products",
          "type": "Number",
          "required": true
        },
        {
          "name": "products",
          "type": "Object[]",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /image/migrate": {
      "id": 1295,
      "path": "/image/migrate",
      "method": "POST",
      "risk": "W",
      "multipart": false,
      "description": "MigrateImage: Use this API to migrate a single image from an external site to Lazada site. Allowed image formats are JPG and PNG. The maximum size of an image file is 1MB. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fimage%2Fmigrate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "Request body"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "POST /images/migrate": {
      "id": 1307,
      "path": "/images/migrate",
      "method": "POST",
      "risk": "W",
      "multipart": false,
      "description": "MigrateImages: Use this API to migrate multiple images from an external site to Lazada site. Allowed image formats are JPG and PNG. The maximum size of an image file is 1MB. A single call can mig Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fimages%2Fmigrate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "Request body"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "batch_id",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /product/pre/check": {
      "id": 1349,
      "path": "/product/pre/check",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "ProductCheck: Use this API to check CB seller quantity limit of adding product . Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fpre%2Fcheck",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "Parameter description"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "POST /product/remove": {
      "id": 1378,
      "path": "/product/remove",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "RemoveProduct: Use this API to remove an existing product, some SKUs in one product, or all SKUs in one product. System supports a maximum number of 50 SellerSkus in one request. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fremove",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "seller_sku_list": {
                "type": "string",
                "maxLength": 262144,
                "description": "sellerSku in a json list to be removed. System supports a maximum number of 50 sellerSku in one request.;for example: itemid: 1269656765 sellerSku: test00111 、test00222、test00333, then Param should be: [\"test00111\",\"test00222\",\"test00333\"]"
              },
              "sku_id_list": {
                "type": "string",
                "maxLength": 262144,
                "description": "Highest priority,skuId in a json list to be removed. System supports a maximum number of 50 skuId in one request.; for example: itemid: 1269656765 skuid: 5230534246, then Param should be: [\"SkuId_1269656765_5230534246\"]"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "POST /product/sku/remove": {
      "id": 1368,
      "path": "/product/sku/remove",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "RemoveSku: Use this API to delete SKUs and sales attributes of corresponding products. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fsku%2Fremove",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "1911687838 color_family 1911687838-1627269303789-1"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "POST /images/set": {
      "id": 1328,
      "path": "/images/set",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "SetImages: Use this API to set the images for an existing product by associating one or more image URLs with it. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fimages%2Fset",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "Parameter description"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "POST /product/price_quantity/update": {
      "id": 1330,
      "path": "/product/price_quantity/update",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "UpdatePriceQuantity: Use this API to update the price and quantity of one or more existing products. The maximum number of products that can be updated is 50, but 20 is recommended. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fprice_quantity%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "Parameter description"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "POST /product/update": {
      "id": 1348,
      "path": "/product/update",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "UpdateProduct: Use this API to update attributes or SKUs of an existing product. if need update inventory, offline, price, not recommended to use this API. The iteration 25/6/2020 Updated for DBS Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "Parameter description"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "POST /product/stock/sellable/update": {
      "id": 1331,
      "path": "/product/stock/sellable/update",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "UpdateSellableQuantity: Use this API to update sellable quantity of one or more existing products. The maximum number of products that can be updated is 50, but 20 is recommended. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fstock%2Fsellable%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "Please take demo as reference."
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "POST /image/upload": {
      "id": 1342,
      "path": "/image/upload",
      "method": "POST",
      "risk": "W",
      "multipart": true,
      "description": "UploadImage: Use this API to upload a single image file to Lazada site. Allowed image formats are JPG and PNG. The maximum size of an image file is 1MB. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fimage%2Fupload",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "image": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]*$"
                  },
                  "content_base64": {
                    "type": "string",
                    "minLength": 4,
                    "maxLength": 262144,
                    "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
                  }
                },
                "required": [
                  "name",
                  "content_base64"
                ],
                "additionalProperties": false,
                "description": "Upload an image file"
              }
            },
            "required": [
              "image"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "POST /product/global/create": {
      "id": 1289,
      "path": "/product/global/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateGlobalProduct: Use this API to create a single new global product to multiple Lazada sites. (For cross boarder sellers ONLY) Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fglobal%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "Parameter description"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "POST /product/global/delete": {
      "id": 2061,
      "path": "/product/global/delete",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "deleteMerchantProduct: Use this API to delete the product。(CrossBoarderSellersOnly) Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fglobal%2Fdelete",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product Types"
              },
              "country": {
                "type": "string",
                "maxLength": 262144,
                "description": "country,if type is \"global\", this field will be ignored"
              },
              "product_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "When type is \"global\", it is the global product ID, when type is \"single\", product id is the IC product ID."
              }
            },
            "required": [
              "type",
              "product_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /product/global/extension": {
      "id": 2047,
      "path": "/product/global/extension",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetGlobalProductExtension: Use this API to query the extension info of the specified global product. (CrossBoarderSellersOnly) Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fglobal%2Fextension",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "global_item_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Batch size is limited to 50"
                },
                "maxItems": 100,
                "description": "Batch size is limited to 50"
              },
              "item_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Batch size is limited to 50, if global_Item_ids is present, this field will be ignored"
                },
                "maxItems": 100,
                "description": "Batch size is limited to 50, if global_Item_ids is present, this field will be ignored"
              },
              "country": {
                "type": "string",
                "maxLength": 262144,
                "description": "country,if global_Item_ids is present, this field will be ignored"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /product/global/status/get": {
      "id": 1341,
      "path": "/product/global/status/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetGlobalProductStatus: Use this API to query the status of the specified global product. It takes several minutes for the global product to be created on each site. (CrossBoarderSellersOnly) Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fglobal%2Fstatus%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "params": {
                "type": "object",
                "properties": {
                  "sellerSku": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Seller SKU selector from the official example."
                  }
                },
                "required": [
                  "sellerSku"
                ],
                "additionalProperties": false,
                "description": "put the \"sellerSku\" as the key"
              }
            },
            "required": [
              "params"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "String",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /product/global/semi/recommend/price/get": {
      "id": 2037,
      "path": "/product/global/semi/recommend/price/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetRecommendPrice: get recommend price Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fglobal%2Fsemi%2Frecommend%2Fprice%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "request data"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /product/global/unfilled/attribute/get": {
      "id": 1379,
      "path": "/product/global/unfilled/attribute/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetUnfilledAttribute: get the product which have attribute not filled （for cross boarder sellers Only） Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fglobal%2Funfilled%2Fattribute%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "offset": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "offset"
              },
              "limit": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "pageSize"
              },
              "attributeTag": {
                "type": "string",
                "maxLength": 262144,
                "description": "only support key_prop"
              }
            },
            "required": [
              "offset",
              "limit",
              "attributeTag"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_detail",
          "type": "String",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "errors",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /product/global/semi/avaible/get": {
      "id": 2036,
      "path": "/product/global/semi/avaible/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetUpgradableGlobalPlusProductList: get an upgradeable global plus product list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fglobal%2Fsemi%2Favaible%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "global"
              },
              "country": {
                "type": "string",
                "maxLength": 262144,
                "description": "country"
              },
              "pageNo": {
                "type": "string",
                "maxLength": 262144,
                "description": "page no"
              },
              "pageSize": {
                "type": "string",
                "maxLength": 262144,
                "description": "page size"
              },
              "currentIndex": {
                "type": "string",
                "maxLength": 262144,
                "description": "current index"
              },
              "itemIds": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "itemId or productId"
                },
                "maxItems": 100,
                "description": "itemId or productId"
              }
            },
            "required": [
              "type",
              "pageNo",
              "pageSize",
              "currentIndex"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /product/global/semi/update": {
      "id": 2049,
      "path": "/product/global/semi/update",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "SemiProductUpdate: SemiProductUpdate Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fglobal%2Fsemi%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "request data"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /product/global/semi/upgrade": {
      "id": 2034,
      "path": "/product/global/semi/upgrade",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "SemiProductUpgrade: SemiProductUpgrade Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fglobal%2Fsemi%2Fupgrade",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "request data"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /product/global/attribute/update": {
      "id": 1380,
      "path": "/product/global/attribute/update",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "UpdateGlobalProductAttribute: update global product attribute (For cross boarder sellers only) Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fglobal%2Fattribute%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "payload": {
                "type": "string",
                "maxLength": 262144,
                "description": "the content want to update"
              }
            },
            "required": [
              "payload"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_detail",
          "type": "String",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "errors",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /product/global/update/status": {
      "id": 2060,
      "path": "/product/global/update/status",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "updateProductStatus: product up shelf or down shelf，(CrossBoarderSellersOnly) Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fproduct%2Fglobal%2Fupdate%2Fstatus",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product Types"
              },
              "country": {
                "type": "string",
                "maxLength": 262144,
                "description": "country,if type is \"global\", this field will be ignored"
              },
              "product_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "When type is \"global\", it is the global product ID, when type is \"single\", product id is the IC product ID."
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "update product type"
              }
            },
            "required": [
              "type",
              "product_id",
              "status"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /review/seller/history/list": {
      "id": 1580,
      "path": "/review/seller/history/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetHistoryReviewIdList: Get history review id list for one seller(reviews within 3 months can be get) Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Freview%2Fseller%2Fhistory%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "item_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product Item ID"
              },
              "order_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Order ID"
              },
              "start_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Start Time, timestamp in millisecond, this is the same with \"create_time\" in the response data of interface (/review/seller/list/v2)；The time range cannot exceed 7 days"
              },
              "end_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "End Time, timestamp in millisecond, this is the same with \"create_time\" in the response data of interface (/review/seller/list/v2)；The time range cannot exceed 7 days"
              },
              "current": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The current pageNo, default value = 1, max value = 50"
              }
            },
            "required": [
              "item_id",
              "start_time",
              "end_time",
              "current"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /review/seller/list/v2": {
      "id": 1479,
      "path": "/review/seller/list/v2",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetReviewListByIdList: get review list by id list, need get id list first Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Freview%2Fseller%2Flist%2Fv2",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id_list": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "id list, maxLength = 10"
                },
                "maxItems": 100,
                "description": "id list, maxLength = 10"
              }
            },
            "required": [
              "id_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /review/seller/reply/add": {
      "id": 1338,
      "path": "/review/seller/reply/add",
      "method": "GET",
      "risk": "H",
      "multipart": false,
      "description": "SubmitSellerReply: submit seller reply for customers review Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Freview%2Fseller%2Freply%2Fadd",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "review id that user wants to reply to. Can be obtain from GetProductReviewList"
              },
              "content": {
                "type": "string",
                "maxLength": 262144,
                "description": "reply content in text, only support reply in text.max length = 500"
              }
            },
            "required": [
              "id",
              "content"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /store/custom/page/get": {
      "id": 1439,
      "path": "/store/custom/page/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetStoreCustomPage: GetStoreCustomPagevice Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fstore%2Fcustom%2Fpage%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "page": {
                "type": "string",
                "maxLength": 262144,
                "description": "page"
              },
              "size": {
                "type": "string",
                "maxLength": 262144,
                "description": "size"
              },
              "keyword": {
                "type": "string",
                "maxLength": 262144,
                "description": "Support keyword search"
              }
            },
            "required": [
              "page",
              "size"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "data",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /media/video/block/commit": {
      "id": 953,
      "path": "/media/video/block/commit",
      "method": "POST",
      "risk": "W",
      "multipart": false,
      "description": "CompleteCreateVideo: After uploading all blocks of the video file, call CompleteCreateVideo to complete the video uploading process. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fmedia%2Fvideo%2Fblock%2Fcommit",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "uploadId": {
                "type": "string",
                "maxLength": 262144,
                "description": "return by calling InitCreateVideo"
              },
              "parts": {
                "type": "string",
                "maxLength": 262144,
                "description": "a json string contains e_tag info of each block"
              },
              "title": {
                "type": "string",
                "maxLength": 262144,
                "description": "the video title"
              },
              "coverUrl": {
                "type": "string",
                "maxLength": 262144,
                "description": "the url of the video's cover image"
              },
              "videoUsage": {
                "type": "string",
                "maxLength": 262144,
                "description": "the usage of video, \"pro_main_video\" represent prodcut main video, \"im\" represent chat video"
              }
            },
            "required": [
              "uploadId",
              "parts",
              "title",
              "coverUrl"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "result_code",
          "type": "String",
          "required": true
        },
        {
          "name": "video_id",
          "type": "String",
          "required": true
        },
        {
          "name": "result_message",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result_code"
          ],
          "name": "result_code",
          "neutral_values": []
        }
      ]
    },
    "GET /media/video/get": {
      "id": 1355,
      "path": "/media/video/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetVideo: You call this action to get video info after uploading. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fmedia%2Fvideo%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "videoId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "the previous return value by calling CompleteCreateVideo"
              }
            },
            "required": [
              "videoId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "cover_url",
          "type": "String",
          "required": true
        },
        {
          "name": "video_url",
          "type": "String",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "result_code",
          "type": "String",
          "required": true
        },
        {
          "name": "state",
          "type": "String",
          "required": true
        },
        {
          "name": "title",
          "type": "String",
          "required": true
        },
        {
          "name": "result_message",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result_code"
          ],
          "name": "result_code",
          "neutral_values": []
        }
      ]
    },
    "GET /media/video/quota/get": {
      "id": 1356,
      "path": "/media/video/quota/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetVideoQuota: You call this api to get the capacity quota of seller. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fmedia%2Fvideo%2Fquota%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "capacity_size",
          "type": "Number",
          "required": true
        },
        {
          "name": "used_size",
          "type": "Number",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "result_code",
          "type": "String",
          "required": true
        },
        {
          "name": "result_message",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result_code"
          ],
          "name": "result_code",
          "neutral_values": []
        }
      ]
    },
    "POST /media/video/block/create": {
      "id": 1354,
      "path": "/media/video/block/create",
      "method": "POST",
      "risk": "W",
      "multipart": false,
      "description": "InitCreateVideo: A seller starts to upload a video file Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fmedia%2Fvideo%2Fblock%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "fileName": {
                "type": "string",
                "maxLength": 262144,
                "description": "local file name of vedio file"
              },
              "fileBytes": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "video file's bytes, should be less than 100M"
              }
            },
            "required": [
              "fileName",
              "fileBytes"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "upload_id",
          "type": "String",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "result_code",
          "type": "String",
          "required": true
        },
        {
          "name": "result_message",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result_code"
          ],
          "name": "result_code",
          "neutral_values": []
        }
      ]
    },
    "POST /media/video/remove": {
      "id": 1381,
      "path": "/media/video/remove",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "RemoveVideo: You can this api to delete a video file permanently. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fmedia%2Fvideo%2Fremove",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "videoId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "the previous return value by calling CompleteCreateVideo"
              }
            },
            "required": [
              "videoId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "result_code",
          "type": "String",
          "required": true
        },
        {
          "name": "result_message",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result_code"
          ],
          "name": "result_code",
          "neutral_values": []
        }
      ]
    },
    "POST /media/video/block/upload": {
      "id": 1382,
      "path": "/media/video/block/upload",
      "method": "POST",
      "risk": "W",
      "multipart": true,
      "description": "UploadVideoBlock: The API is used to upload one block of origin video file. The video file can split into multiple files. For example, a 8MB video file can be split into three blocks. 3MB, 3MB and 2 Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fmedia%2Fvideo%2Fblock%2Fupload",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "uploadId": {
                "type": "string",
                "maxLength": 262144,
                "description": "return by calling InitCreateVideo"
              },
              "blockNo": {
                "type": "string",
                "maxLength": 262144,
                "description": "the current block number, from 0 to N-1"
              },
              "blockCount": {
                "type": "string",
                "maxLength": 262144,
                "description": "total block count of file"
              },
              "file": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]*$"
                  },
                  "content_base64": {
                    "type": "string",
                    "minLength": 4,
                    "maxLength": 262144,
                    "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
                  }
                },
                "required": [
                  "name",
                  "content_base64"
                ],
                "additionalProperties": false,
                "description": "binary content of the current block"
              }
            },
            "required": [
              "uploadId",
              "blockNo",
              "blockCount",
              "file"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "result_code",
          "type": "String",
          "required": true
        },
        {
          "name": "e_tag",
          "type": "String",
          "required": true
        },
        {
          "name": "result_message",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result_code"
          ],
          "name": "result_code",
          "neutral_values": []
        }
      ]
    },
    "POST /promotion/flexicombo/activate": {
      "id": 1362,
      "path": "/promotion/flexicombo/activate",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "ActivateFlexiCombo: activate flexi combo Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fflexicombo%2Factivate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "id"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/flexicombo/products/add": {
      "id": 1361,
      "path": "/promotion/flexicombo/products/add",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "AddFlexiComboProducts: add flexi combo products Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fflexicombo%2Fproducts%2Fadd",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion id"
              },
              "sku_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "sku list that will be added to this flexi combo"
                },
                "maxItems": 100,
                "description": "sku list that will be added to this flexi combo"
              }
            },
            "required": [
              "id",
              "sku_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/flexicombo/create": {
      "id": 1360,
      "path": "/promotion/flexicombo/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateFlexiCombo: create a new promotion flexi combo Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fflexicombo%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "apply": {
                "type": "string",
                "maxLength": 262144,
                "description": "apply scope: ENTIRE_STORE | SPECIFIC_PRODUCTS"
              },
              "sample_skus": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "productId": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "sample product id"
                    },
                    "skuId": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "sample sku id"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "sample list"
                },
                "maxItems": 100,
                "description": "sample list"
              },
              "criteria_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "AMOUNT | QUANTITY"
              },
              "criteria_value": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "criteria value list"
                },
                "maxItems": 100,
                "description": "criteria value list"
              },
              "order_numbers": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "orders numbers that can use flexi combo"
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "flexi combo name"
              },
              "platform_channel": {
                "type": "string",
                "maxLength": 262144,
                "description": "platform channel, default is 1"
              },
              "gift_skus": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "productId": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "gift product id"
                    },
                    "skuId": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "gift sku id"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "gift list"
                },
                "maxItems": 100,
                "description": "gift list"
              },
              "start_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "start time"
              },
              "discount_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "money | discount | freeGift | freeSample | discountWithGift | moneyWithGift | discountWithSample | moneyWithSample"
              },
              "end_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "end time"
              },
              "discount_value": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "discount value list"
                },
                "maxItems": 100,
                "description": "discount value list"
              },
              "stackable": {
                "type": "string",
                "maxLength": 262144,
                "description": "Stackable Discount，Ex. Buy 2SGD Save 1SGD, Buy 4SGD Save 2SGD, Buy 6SGD Save 3SGD, etc."
              },
              "gift_buy_limit_value": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "buyer can choose gift/sample quantity limit value list"
                },
                "maxItems": 100,
                "description": "buyer can choose gift/sample quantity limit value list"
              }
            },
            "required": [
              "apply",
              "criteria_type",
              "criteria_value",
              "order_numbers",
              "name",
              "start_time",
              "discount_type",
              "end_time",
              "discount_value"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Number",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/flexicombo/deactivate": {
      "id": 1363,
      "path": "/promotion/flexicombo/deactivate",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "DeactivateFlexiCombo: deactivate flexi combo Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fflexicombo%2Fdeactivate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "id"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/flexicombo/products/delete": {
      "id": 1364,
      "path": "/promotion/flexicombo/products/delete",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "DeleteFlexiComboProducts: delete flexi combo products Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fflexicombo%2Fproducts%2Fdelete",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "id"
              },
              "sku_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "sku list that will remove from flexi combo"
                },
                "maxItems": 100,
                "description": "sku list that will remove from flexi combo"
              }
            },
            "required": [
              "id",
              "sku_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /promotion/flexicombo/details": {
      "id": 1365,
      "path": "/promotion/flexicombo/details",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetFlexiComboDetails: get promotion flexi combo detail by id Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fflexicombo%2Fdetails",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "id"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /promotion/flexicombo/list": {
      "id": 1366,
      "path": "/promotion/flexicombo/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "ListFlexiCombo: list flexi combo Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fflexicombo%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "cur_page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "current page"
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "name"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size"
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "NOT_START | ONGOING | SUSPEND | FINISH"
              }
            },
            "required": [
              "cur_page",
              "page_size"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        },
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /promotion/flexicombo/products/list": {
      "id": 1367,
      "path": "/promotion/flexicombo/products/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "ListFlexiComboProducts: list flexi combo products Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fflexicombo%2Fproducts%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "cur_page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "current page"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size;Maximum value: 100; Minimum value: 10"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "flexi combo id"
              }
            },
            "required": [
              "cur_page",
              "page_size",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/flexicombo/update": {
      "id": 1417,
      "path": "/promotion/flexicombo/update",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "UpdateFlexiCombo: update flexi combo Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fflexicombo%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "apply": {
                "type": "string",
                "maxLength": 262144,
                "description": "apply scope: ENTIRE_SHOP | SPECIFIC_PRODUCTS"
              },
              "sample_skus": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "productId": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "sample product id"
                    },
                    "skuId": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "sample sku id"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "sample list"
                },
                "maxItems": 100,
                "description": "sample list"
              },
              "criteria_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "AMOUNT | QUANTITY"
              },
              "criteria_value": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "criteria value list"
                },
                "maxItems": 100,
                "description": "criteria value list"
              },
              "order_numbers": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "orders numbers that can use flexi combo"
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "flexi combo name"
              },
              "platform_channel": {
                "type": "string",
                "maxLength": 262144,
                "description": "platform channel"
              },
              "gift_skus": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "productId": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "gift product id"
                    },
                    "skuId": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "gift sku id"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "gift list"
                },
                "maxItems": 100,
                "description": "gift list"
              },
              "start_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "start time"
              },
              "discount_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "money | discount | freeGift | freeSample | discountWithGift | moneyWithGift | discountWithSample | moneyWithSample"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "flexi combo id"
              },
              "end_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "end time"
              },
              "discount_value": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "discount value list"
                },
                "maxItems": 100,
                "description": "discount value list"
              },
              "stackable": {
                "type": "string",
                "maxLength": 262144,
                "description": "Stackable Discount，Ex. Buy 2SGD Save 1SGD, Buy 4SGD Save 2SGD, Buy 6SGD Save 3SGD, etc."
              },
              "gift_buy_limit_value": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "buyer can choose gift/sample quantity limit value list"
                },
                "maxItems": 100,
                "description": "buyer can choose gift/sample quantity limit value list"
              }
            },
            "required": [
              "apply",
              "criteria_type",
              "criteria_value",
              "order_numbers",
              "name",
              "start_time",
              "discount_type",
              "id",
              "end_time",
              "discount_value"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/voucher/product/sku/remove": {
      "id": 1377,
      "path": "/promotion/voucher/product/sku/remove",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "SellerVoucheDeleteSelectedProductSKU: delete seller voucher promotion product sku Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fvoucher%2Fproduct%2Fsku%2Fremove",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "voucher_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "voucher type COLLECTIBLE_VOUCHER | CODE_VOUCHER"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion ID"
              },
              "sku_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "sku ID list"
                },
                "maxItems": 100,
                "description": "sku ID list"
              }
            },
            "required": [
              "voucher_type",
              "id",
              "sku_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/voucher/activate": {
      "id": 976,
      "path": "/promotion/voucher/activate",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "SellerVoucherActivate: activate seller voucher promotion Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fvoucher%2Factivate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "voucher_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "voucher type COLLECTIBLE_VOUCHER | CODE_VOUCHER"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Promotion ID"
              }
            },
            "required": [
              "voucher_type",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/voucher/product/sku/add": {
      "id": 1369,
      "path": "/promotion/voucher/product/sku/add",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "SellerVoucherAddSelectedProductSKU: add seller voucher promotion product sku Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fvoucher%2Fproduct%2Fsku%2Fadd",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "voucher_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "voucher type COLLECTIBLE_VOUCHER | CODE_VOUCHER"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion ID"
              },
              "sku_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "sku ID list"
                },
                "maxItems": 100,
                "description": "sku ID list"
              }
            },
            "required": [
              "voucher_type",
              "id",
              "sku_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/voucher/create": {
      "id": 1370,
      "path": "/promotion/voucher/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "SellerVoucherCreate: create a new seller voucher promotion Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fvoucher%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "criteria_over_money": {
                "type": "string",
                "maxLength": 262144,
                "description": "Discount details, if order value reaches set value, will money discount or percentage discount"
              },
              "voucher_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Voucher type, just set COLLECTIBLE_VOUCHER"
              },
              "apply": {
                "type": "string",
                "maxLength": 262144,
                "description": "apply scope: ENTIRE_SHOP | SPECIFIC_PRODUCTS"
              },
              "collect_start": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The time that customers can collect the voucher"
              },
              "display_area": {
                "type": "string",
                "maxLength": 262144,
                "description": "The area that customers can see the voucher. REGULAR_CHANNEL|STORE_FOLLOWER|OFFLINE|LIVE_STREAM|CEM_SELLER"
              },
              "period_end_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The period end time that customers can use the voucher"
              },
              "voucher_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Voucher name"
              },
              "voucher_discount_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Discount type, MONEY_VALUE_OFF | PERCENTAGE_DISCOUNT_OFF"
              },
              "offering_money_value_off": {
                "type": "string",
                "maxLength": 262144,
                "description": "Discount details, if order value reaches criteria_over_money value, will discount money value"
              },
              "period_start_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The period start time that customers can use the voucher"
              },
              "limit": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Voucher limit per customer"
              },
              "issued": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Revision should be greater than the current setting"
              },
              "max_discount_offering_money_value": {
                "type": "string",
                "maxLength": 262144,
                "description": "Discount details, if order value reaches criteria_over_money value, allow maximum discount per order, just support percentage discount off type"
              },
              "offering_percentage_discount_off": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Discount details, if order value reaches criteria_over_money value, will percentage discount off value"
              }
            },
            "required": [
              "criteria_over_money",
              "voucher_type",
              "apply",
              "display_area",
              "period_end_time",
              "voucher_name",
              "voucher_discount_type",
              "period_start_time",
              "limit",
              "issued"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Number",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/voucher/deactivate": {
      "id": 1375,
      "path": "/promotion/voucher/deactivate",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "SellerVoucherDeactivate: deactivate seller voucher promotion Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fvoucher%2Fdeactivate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "voucher_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "voucher type COLLECTIBLE_VOUCHER | CODE_VOUCHER"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Promotion ID"
              }
            },
            "required": [
              "voucher_type",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /promotion/voucher/get": {
      "id": 1345,
      "path": "/promotion/voucher/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "SellerVoucherDetailQuery: get a seller voucher promotion detail Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fvoucher%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "voucher_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "voucher type COLLECTIBLE_VOUCHER | CODE_VOUCHER"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion ID"
              }
            },
            "required": [
              "voucher_type",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /promotion/vouchers/get": {
      "id": 1374,
      "path": "/promotion/vouchers/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "SellerVoucherList: query seller voucher promotion list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fvouchers%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "cur_page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "current page"
              },
              "voucher_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "voucher type COLLECTIBLE_VOUCHER | CODE_VOUCHER"
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "promotion name"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size"
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "NOT_START | ONGOING | SUSPEND | FINISH"
              }
            },
            "required": [
              "voucher_type"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /promotion/voucher/products/get": {
      "id": 1444,
      "path": "/promotion/voucher/products/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "SellerVoucherSelectedProductList: query seller voucher selected products list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fvoucher%2Fproducts%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "voucher_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "voucher type COLLECTIBLE_VOUCHER | CODE_VOUCHER"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Promotion ID"
              },
              "cur_page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "cur page"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size"
              }
            },
            "required": [
              "voucher_type",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/voucher/update": {
      "id": 1376,
      "path": "/promotion/voucher/update",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "SellerVoucherUpdate: update a existing seller voucher promotion Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fvoucher%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "max_discount_offering_money_value": {
                "type": "string",
                "maxLength": 262144,
                "description": "Discount details, if order value reaches criteria_over_money value, allow maximum discount per order, just support percentage discount off type"
              },
              "offering_percentage_discount_off": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Discount details, if order value reaches criteria_over_money value, will percentage discount off value"
              },
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Promotion ID"
              },
              "criteria_over_money": {
                "type": "string",
                "maxLength": 262144,
                "description": "Discount details, if order value reaches set value, will money discount or percentage discount"
              },
              "voucher_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Voucher type, just set COLLECTIBLE_VOUCHER"
              },
              "apply": {
                "type": "string",
                "maxLength": 262144,
                "description": "apply scope: ENTIRE_SHOP | SPECIFIC_PRODUCTS"
              },
              "collect_start": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The time that customers can collect the voucher"
              },
              "display_area": {
                "type": "string",
                "maxLength": 262144,
                "description": "The area that customers can see the voucher."
              },
              "period_end_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The period end time that customers can use the voucher"
              },
              "voucher_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Voucher name"
              },
              "voucher_discount_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Discount type"
              },
              "offering_money_value_off": {
                "type": "string",
                "maxLength": 262144,
                "description": "Discount details, if order value reaches criteria_over_money value, will discount money value"
              },
              "period_start_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The period start time that customers can use the voucher"
              },
              "limit": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Voucher limit per customer"
              },
              "issued": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Revision should be greater than the current setting"
              }
            },
            "required": [
              "id",
              "criteria_over_money",
              "voucher_type",
              "apply",
              "display_area",
              "period_end_time",
              "voucher_name",
              "voucher_discount_type",
              "offering_money_value_off",
              "period_start_time",
              "limit",
              "issued"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Number",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/freeshipping/activate": {
      "id": 1310,
      "path": "/promotion/freeshipping/activate",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "FreeShippingActivate: activate free shipping promotion Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Ffreeshipping%2Factivate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion id"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /promotion/freeshipping/product/sku/add": {
      "id": 1311,
      "path": "/promotion/freeshipping/product/sku/add",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "FreeShippingAddSelectedProductSKU: add sku for free shipping promotion Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Ffreeshipping%2Fproduct%2Fsku%2Fadd",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion id"
              },
              "sku_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "sku id list"
                },
                "maxItems": 100,
                "description": "sku id list"
              }
            },
            "required": [
              "id",
              "sku_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /promotion/freeshipping/create": {
      "id": 1312,
      "path": "/promotion/freeshipping/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "FreeShippingCreate: create a new free shipping promotion Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Ffreeshipping%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "budget_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "UNLIMITED_BUDGET | LIMITED_BUDGET"
              },
              "template_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "template type, MANUALLY | CAMPAIGN | TEMPLATE"
              },
              "apply": {
                "type": "string",
                "maxLength": 262144,
                "description": "apply scope: ENTIRE_SHOP | SPECIFIC_PRODUCTS | CAMPAIGN_PRODUCTS"
              },
              "period_end_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "when specific period required, the period end time that this promotion takes effect (timestamp)"
              },
              "template_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "template code"
              },
              "category_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "product category id"
              },
              "budget_value": {
                "type": "string",
                "maxLength": 262144,
                "description": "when limited budget required"
              },
              "promotion_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "promotion name"
              },
              "period_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "LONG_TERM | SPECIAL_PERIOD"
              },
              "region_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "ALL_REGIONS | SPECIAL_REGIONS, when regions query api return empty just support ALL_REGIONS"
              },
              "period_start_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "when specific period required, the period start time that this promotion takes effect (timestamp)"
              },
              "campaign_tag": {
                "type": "string",
                "maxLength": 262144,
                "description": "when CAMPAIGN template type and CAMPAIGN_PRODUCTS apply type required"
              },
              "region_value": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "when SPECIAL_REGIONS required, data from regions query api"
                },
                "maxItems": 100,
                "description": "when SPECIAL_REGIONS required, data from regions query api"
              },
              "delivery_option": {
                "type": "string",
                "maxLength": 262144,
                "description": "data from delivery options query list api"
              },
              "tiers": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "filter": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "deal criteria value"
                    },
                    "result": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "when partial subsidy discount type required，shipping fee subsidy value"
                    }
                  },
                  "required": [
                    "filter"
                  ],
                  "additionalProperties": false,
                  "description": "promotion tier list"
                },
                "maxItems": 100,
                "description": "promotion tier list"
              },
              "discount_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "shipping fee subsidy type,FULL_SUBSIDY|PARTIAL_SUBSIDY"
              },
              "deal_criteria": {
                "type": "string",
                "maxLength": 262144,
                "description": "the criteria that customer can enjoy shipping fee subsidy, MONEY_VALUE_FROM_X|ITEM_QUANTITY_FROM_X|NO_CONDITION"
              }
            },
            "required": [
              "budget_type",
              "apply",
              "period_end_time",
              "promotion_name",
              "period_type",
              "region_type",
              "period_start_time",
              "delivery_option",
              "tiers",
              "discount_type",
              "deal_criteria"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Number",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/freeshipping/deactivate": {
      "id": 1464,
      "path": "/promotion/freeshipping/deactivate",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "FreeShippingDeactivate: deactivate free shipping promotion Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Ffreeshipping%2Fdeactivate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion id"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /promotion/freeshipping/product/sku/remove": {
      "id": 1442,
      "path": "/promotion/freeshipping/product/sku/remove",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "FreeShippingDeleteSelectedProductSKU: delete sku for free shipping promotion Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Ffreeshipping%2Fproduct%2Fsku%2Fremove",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion id"
              },
              "sku_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "sku id list"
                },
                "maxItems": 100,
                "description": "sku id list"
              }
            },
            "required": [
              "id",
              "sku_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /promotion/freeshipping/deliveryoptions/get": {
      "id": 1409,
      "path": "/promotion/freeshipping/deliveryoptions/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "FreeShippingDeliveryOptionsQuery: query free shipping promotion delivery options Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Ffreeshipping%2Fdeliveryoptions%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /promotion/freeshipping/get": {
      "id": 1428,
      "path": "/promotion/freeshipping/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "FreeShippingGet: get free shipping promotion Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Ffreeshipping%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion id"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /promotion/freeshippings/get": {
      "id": 1419,
      "path": "/promotion/freeshippings/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "FreeShippingList: query free shipping promotion list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Ffreeshippings%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "curPage": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "current page"
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "promotion name"
              },
              "pageSize": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size"
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "NOT_START | ONGOING | SUSPEND | FINISH"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /promotion/freeshipping/regions/get": {
      "id": 1449,
      "path": "/promotion/freeshipping/regions/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "FreeShippingRegionsQuery: query free shipping promotion regions Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Ffreeshipping%2Fregions%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /promotion/freeshipping/products/get": {
      "id": 1427,
      "path": "/promotion/freeshipping/products/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "FreeShippingSelectedProductList: query free shipping promotion selected product list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Ffreeshipping%2Fproducts%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "curPage": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "current page"
              },
              "pageSize": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion id"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /promotion/freeshipping/update": {
      "id": 1448,
      "path": "/promotion/freeshipping/update",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "FreeShippingUpdate: update free shipping promotion Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Ffreeshipping%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "budget_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "UNLIMITED_BUDGET | LIMITED_BUDGET"
              },
              "template_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "template type, MANUALLY | CAMPAIGN | TEMPLATE"
              },
              "apply": {
                "type": "string",
                "maxLength": 262144,
                "description": "apply scope: ENTIRE_SHOP | SPECIFIC_PRODUCTS | CAMPAIGN_PRODUCTS"
              },
              "period_end_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "when specific period required, the period end time that this promotion takes effect (timestamp)"
              },
              "template_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "template code"
              },
              "category_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "product category id"
              },
              "budget_value": {
                "type": "string",
                "maxLength": 262144,
                "description": "when limited budget required"
              },
              "promotion_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "promotion name"
              },
              "period_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "LONG_TERM | SPECIAL_PERIOD"
              },
              "region_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "ALL_REGIONS | SPECIAL_REGIONS, when regions query api return empty just support ALL_REGIONS"
              },
              "period_start_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "when specific period required, the period start time that this promotion takes effect (timestamp)"
              },
              "campaign_tag": {
                "type": "string",
                "maxLength": 262144,
                "description": "when CAMPAIGN template type and CAMPAIGN_PRODUCTS apply type required"
              },
              "region_value": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "when SPECIAL_REGIONS required, data from regions query api"
                },
                "maxItems": 100,
                "description": "when SPECIAL_REGIONS required, data from regions query api"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion id"
              },
              "delivery_option": {
                "type": "string",
                "maxLength": 262144,
                "description": "data from delivery options query list api"
              },
              "discount_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "shipping fee subsidy type,FULL_SUBSIDY|PARTIAL_SUBSIDY"
              },
              "deal_criteria": {
                "type": "string",
                "maxLength": 262144,
                "description": "the criteria that customer can enjoy shipping fee subsidy, MONEY_VALUE_FROM_X|ITEM_QUANTITY_FROM_X|NO_CONDITION"
              },
              "tiers": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "filter": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "deal criteria value"
                    },
                    "result": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "when partial subsidy discount type required，shipping fee subsidy value"
                    }
                  },
                  "required": [
                    "filter"
                  ],
                  "additionalProperties": false,
                  "description": "promotion tier list"
                },
                "maxItems": 100,
                "description": "promotion tier list"
              }
            },
            "required": [
              "budget_type",
              "template_type",
              "apply",
              "period_end_time",
              "promotion_name",
              "period_type",
              "region_type",
              "period_start_time",
              "id",
              "delivery_option",
              "discount_type",
              "deal_criteria",
              "tiers"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Number",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /activity/early/bird/create/v2": {
      "id": 138382,
      "path": "/activity/early/bird/create/v2",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateEarlyBirdActivityV2: early bird price activity create Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Factivity%2Fearly%2Fbird%2Fcreate%2Fv2",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "sku_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "product_id": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "item id"
                    },
                    "order_total_budget": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "activity inventory"
                    },
                    "discount_price": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "discount price"
                    },
                    "sku_id": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "skuId"
                    }
                  },
                  "required": [
                    "product_id",
                    "order_total_budget",
                    "discount_price",
                    "sku_id"
                  ],
                  "additionalProperties": false,
                  "description": "sku list"
                },
                "maxItems": 100,
                "description": "sku list"
              },
              "page_no": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page no"
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "activity name"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page_size"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "activity id"
              },
              "source": {
                "type": "string",
                "maxLength": 262144,
                "description": "source"
              }
            },
            "required": [
              "sku_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /activity/early/bird/addSkus/v2": {
      "id": 138394,
      "path": "/activity/early/bird/addSkus/v2",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "EarlyBirdActivityAddSkusV2: add skus for early bird activity Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Factivity%2Fearly%2Fbird%2FaddSkus%2Fv2",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "sku_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "product_id": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "product id"
                    },
                    "order_total_budget": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "order total budget inventory"
                    },
                    "discount_price": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "discount price"
                    },
                    "sku_id": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "sku id"
                    }
                  },
                  "required": [
                    "product_id",
                    "order_total_budget",
                    "discount_price",
                    "sku_id"
                  ],
                  "additionalProperties": false,
                  "description": "sku list"
                },
                "maxItems": 100,
                "description": "sku list"
              },
              "page_no": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page no"
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "activity name"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "activity id"
              },
              "source": {
                "type": "string",
                "maxLength": 262144,
                "description": "source"
              }
            },
            "required": [
              "sku_list",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /activity/early/bird/deactivateSkus/v2": {
      "id": 138396,
      "path": "/activity/early/bird/deactivateSkus/v2",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "EarlyBirdActivityDeactivateSkusV2: deactivate Skus for early bird acivity Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Factivity%2Fearly%2Fbird%2FdeactivateSkus%2Fv2",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "sku_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "product_id": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "item id"
                    },
                    "order_total_budget": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "order total budget inventory"
                    },
                    "discount_price": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "discount price"
                    },
                    "sku_id": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "sku id"
                    }
                  },
                  "required": [
                    "product_id",
                    "order_total_budget",
                    "discount_price",
                    "sku_id"
                  ],
                  "additionalProperties": false,
                  "description": "sku list"
                },
                "maxItems": 100,
                "description": "sku list"
              },
              "page_no": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page no"
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "activity name"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "activity id"
              },
              "source": {
                "type": "string",
                "maxLength": 262144,
                "description": "source"
              }
            },
            "required": [
              "sku_list",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /activity/early/bird/isWhitelistSeller": {
      "id": 138397,
      "path": "/activity/early/bird/isWhitelistSeller",
      "method": "POST",
      "risk": "R",
      "multipart": false,
      "description": "EarlyBirdActivityIsWhitelistSeller: is whitelist seller for early bird acivity Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Factivity%2Fearly%2Fbird%2FisWhitelistSeller",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /order/document/get": {
      "id": 961,
      "path": "/order/document/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetDocument: Use this API to retrieve order-related documents, including invoices and shipping labels. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fdocument%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "doc_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Document types, including 'invoice', 'shippingLabel', or 'carrierManifest'. Mandatory."
              },
              "order_item_ids": {
                "type": "string",
                "maxLength": 262144,
                "description": "Identifier of the order item for which the caller wants to get a document. Mandatory."
              }
            },
            "required": [
              "doc_type",
              "order_item_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /orders/items/get": {
      "id": 954,
      "path": "/orders/items/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetMultipleOrderItems: Use this API to get the item information of one or more orders.（No more than 50 at a time） Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forders%2Fitems%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "order_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Comma-separated list of order identifiers in square brackets.（No more than 50 at a time）"
                },
                "maxItems": 100,
                "description": "Comma-separated list of order identifiers in square brackets.（No more than 50 at a time）"
              }
            },
            "required": [
              "order_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /order/get": {
      "id": 1130,
      "path": "/order/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetOrder: Use this API to get the list of items for a single order. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The identifier that was assigned to the order by the Seller Center"
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /order/items/get": {
      "id": 966,
      "path": "/order/items/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetOrderItems: Use this API to get the item information of an order. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fitems%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The identifier that was assigned to the order by the Seller Center."
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /orders/get": {
      "id": 1131,
      "path": "/orders/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetOrders: Use this API to get the list of items for a range of orders1.. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forders%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "update_before": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned orders to those updated before or on the specified date, given in ISO 8601 date format. Optional."
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Specify the sorting type. Possible values are ASC and DESC.",
                "enum": [
                  "ASC",
                  "DESC"
                ]
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991,
                "description": "Number of orders to skip at the beginning of the list."
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of orders that can be returned. The supported maximum number is 100."
              },
              "update_after": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned orders to those updated after or on the specified date, given in ISO 8601 date format. Either UpdatedAfter or CreatedAfter is mandatory."
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Allows to choose the sorting column. Possible values are created_at and updated_at.",
                "enum": [
                  "created_at",
                  "updated_at"
                ]
              },
              "created_before": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned orders to those updated before or on the specified date, given in ISO 8601 date format. Optional."
              },
              "created_after": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned orders to those updated after or on the specified date, given in ISO 8601 date format. Either UpdatedAfter or CreatedAfter is mandatory."
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "When set, limits the returned set of orders to loose orders, which return only entries which fit the status provided. Possible values are unpaid, pending, canceled, ready_to_ship, delivered, returned, shipped , failed, topack,toship,shipping and lost"
              }
            },
            "required": [],
            "additionalProperties": false,
            "anyOf": [
              {
                "required": [
                  "created_after"
                ]
              },
              {
                "required": [
                  "update_after"
                ]
              }
            ]
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /orders/ovo/get": {
      "id": 959,
      "path": "/orders/ovo/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetOVOOrders: This interface is only applicable to the merchant side of the business and is used to set the maximum number of SKUs that certain merchants can sell per day Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forders%2Fovo%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "tradeOrderIds": {
                "type": "string",
                "maxLength": 262144,
                "description": "id"
              }
            },
            "required": [
              "tradeOrderIds"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /order/reverse/cancel/validate": {
      "id": 1426,
      "path": "/order/reverse/cancel/validate",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "OrderCancelValidate: Seller can check whether the order can be canceled through this API and get corresponding reasons if not. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Freverse%2Fcancel%2Fvalidate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "order id"
              },
              "order_item_id_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "all order items need to be cancel"
                },
                "maxItems": 100,
                "description": "all order items need to be cancel"
              }
            },
            "required": [
              "order_id",
              "order_item_id_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "POST /order/invoice_number/set": {
      "id": 958,
      "path": "/order/invoice_number/set",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "SetInvoiceNumber: Use this API to set the invoice number for the specified order. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Finvoice_number%2Fset",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "order_item_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Identifier of the order item."
              },
              "invoice_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "The invoice number."
              }
            },
            "required": [
              "order_item_id",
              "invoice_number"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /order/reverse/return/detail/list": {
      "id": 1315,
      "path": "/order/reverse/return/detail/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetReverseOrderDetail: Get the detailed information for a specific reverse order Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Freverse%2Freturn%2Fdetail%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "reverse_order_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "0"
              }
            },
            "required": [
              "reverse_order_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /order/reverse/return/history/list": {
      "id": 1316,
      "path": "/order/reverse/return/history/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetReverseOrderHistoryList: Get the communication history of the reverse order Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Freverse%2Freturn%2Fhistory%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "reverse_order_line_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "reverse order line id"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "default 10"
              },
              "page_number": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "default 1"
              }
            },
            "required": [
              "reverse_order_line_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /order/reverse/reason/list": {
      "id": 1317,
      "path": "/order/reverse/reason/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetReverseOrderReasonList: Get the list of reject reason. Need to be used in all refuse refund actions Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Freverse%2Freason%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "reverse_order_line_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "reverse order line,Can be understood as reverse order item id"
              }
            },
            "required": [
              "reverse_order_line_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /reverse/getreverseordersforseller": {
      "id": 1318,
      "path": "/reverse/getreverseordersforseller",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetReverseOrdersForSeller: Use this API to get the list of items for a range of reverse orders. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Freverse%2Fgetreverseordersforseller",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "request_type_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "request type"
                },
                "maxItems": 100,
                "description": "request type"
              },
              "ofc_status_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "Limit the ofc status"
                },
                "maxItems": 100,
                "description": "Limit the ofc status"
              },
              "reverse_order_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Specify reverse order id"
              },
              "trade_order_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Specify trade order id"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page size, default 10"
              },
              "reverse_status_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "Limit the reverse status."
                },
                "maxItems": 100,
                "description": "Limit the reverse status."
              },
              "page_no": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page no"
              },
              "return_to_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Return Type. Enum Values：[RTM, RTW]（ RTW: return to the lazada warehouse; RTM: return to the seller）"
              },
              "dispute_in_progress": {
                "type": "boolean",
                "description": "Is dispute in progress"
              },
              "TradeOrderLineCreatedTimeRangeStart": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "timestamp in Milliseconds"
              },
              "TradeOrderLineCreatedTimeRangeEnd": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "timestamp in Milliseconds"
              },
              "ReverseOrderLineTimeRangeStart": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "timestamp in Milliseconds"
              },
              "ReverseOrderLineTimeRangeEnd": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "timestamp in Milliseconds"
              },
              "ReverseOrderLineModifiedTimeRangeStart": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "timestamp in Milliseconds"
              },
              "ReverseOrderLineModifiedTimeRangeEnd": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "timestamp in Milliseconds"
              },
              "QC_Decision": {
                "type": "string",
                "maxLength": 262144,
                "description": "warehouse qc decision, select one from the following: scrap/return_to_merchant/return_to_merchant_cb/return_to_customer/return_to_warehouse/not_returned"
              }
            },
            "required": [
              "page_size",
              "page_no"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /order/reverse/cancel/create": {
      "id": 1474,
      "path": "/order/reverse/cancel/create",
      "method": "GET",
      "risk": "D",
      "multipart": false,
      "description": "InitReverseOrderCancel: Seller initiates a cancelation Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Freverse%2Fcancel%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "order_item_id_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "all order items need to be cancel"
                },
                "maxItems": 100,
                "description": "all order items need to be cancel"
              },
              "order_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "order id"
              },
              "reason_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "reason id"
              }
            },
            "required": [
              "order_item_id_list",
              "order_id",
              "reason_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /order/reverse/cancel/seller/decide": {
      "id": 1319,
      "path": "/order/reverse/cancel/seller/decide",
      "method": "GET",
      "risk": "D",
      "multipart": false,
      "description": "InitReverseOrderCancelDecide: Seller initiates a cancelation Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Freverse%2Fcancel%2Fseller%2Fdecide",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "reverse_order_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The reverse order to be cancelled"
              },
              "agree_cancel": {
                "type": "boolean",
                "description": "decision"
              },
              "reason_code": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "reason id"
              }
            },
            "required": [
              "reverse_order_id",
              "agree_cancel"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /order/reverse/onlyrefund/seller/decide": {
      "id": 121825,
      "path": "/order/reverse/onlyrefund/seller/decide",
      "method": "GET",
      "risk": "H",
      "multipart": false,
      "description": "ReverseOrderOnlyRefundDecide: Seller can use this API to operate only refund requests Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Freverse%2Fonlyrefund%2Fseller%2Fdecide",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "action": {
                "type": "string",
                "maxLength": 262144,
                "description": "agreeRefund, startDispute"
              },
              "reverse_order_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "reverse order id"
              },
              "reverse_order_item_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "reverse order item id list, currently list size can be only 1"
                },
                "maxItems": 100,
                "description": "reverse order item id list, currently list size can be only 1"
              },
              "comment": {
                "type": "string",
                "maxLength": 262144,
                "description": "comment, required if action is startDispute"
              },
              "image_info_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "file_name": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "image name"
                    },
                    "file_url": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "image url"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "image info list, required if action is startDispute"
                },
                "maxItems": 100,
                "description": "image info list, required if action is startDispute"
              },
              "video_info_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "cover_url": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "cover url"
                    },
                    "video_url": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "video url"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "video info list"
                },
                "maxItems": 100,
                "description": "video info list"
              }
            },
            "required": [
              "action",
              "reverse_order_id",
              "reverse_order_item_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /order/reverse/return/update": {
      "id": 1320,
      "path": "/order/reverse/return/update",
      "method": "GET",
      "risk": "H",
      "multipart": false,
      "description": "ReverseOrderReturnUpdate: Seller can use this API to action on return and refund related. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Freverse%2Freturn%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "action": {
                "type": "string",
                "maxLength": 262144,
                "description": "instantRefund;agreeReturn;refuseReturn;agreeRefund;refuseRefund;confirmDelivery"
              },
              "reverse_order_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "reverse order id"
              },
              "reverse_order_item_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "reverse order item id list"
                },
                "maxItems": 100,
                "description": "reverse order item id list"
              },
              "reason_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "reason id"
              },
              "comment": {
                "type": "string",
                "maxLength": 262144,
                "description": "comment"
              },
              "image_info": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "image name"
                    },
                    "url": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "image url"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "image_info"
                },
                "maxItems": 100,
                "description": "image_info"
              }
            },
            "required": [
              "action",
              "reverse_order_id",
              "reverse_order_item_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "POST /order/package/sof/collect": {
      "id": 156769,
      "path": "/order/package/sof/collect",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "ConfirmCollectForDBS: Use this API to mark an sof order item as being collected. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fpackage%2Fsof%2Fcollect",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "dbsCollectReq": {
                "type": "object",
                "properties": {
                  "packages": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "package_id": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "package id"
                        }
                      },
                      "required": [
                        "package_id"
                      ],
                      "additionalProperties": false,
                      "description": "Batch size is limited to 20"
                    },
                    "maxItems": 100,
                    "description": "Batch size is limited to 20"
                  }
                },
                "required": [
                  "packages"
                ],
                "additionalProperties": false,
                "description": "request body"
              }
            },
            "required": [
              "dbsCollectReq"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "data",
            "packages",
            "*",
            "item_err_code"
          ],
          "name": "item_err_code",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /order/package/sof/delivered": {
      "id": 1466,
      "path": "/order/package/sof/delivered",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "ConfirmDeliveryForDBS: Use this API to mark an sof order item as being delivered. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fpackage%2Fsof%2Fdelivered",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "dbsDeliveryReq": {
                "type": "object",
                "properties": {
                  "packages": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "package_id": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "packageId"
                        }
                      },
                      "required": [
                        "package_id"
                      ],
                      "additionalProperties": false,
                      "description": "Batch size is limited to 20"
                    },
                    "maxItems": 100,
                    "description": "Batch size is limited to 20"
                  }
                },
                "required": [
                  "packages"
                ],
                "additionalProperties": false,
                "description": "request body"
              }
            },
            "required": [
              "dbsDeliveryReq"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "data",
            "packages",
            "*",
            "item_err_code"
          ],
          "name": "item_err_code",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /order/digital/delivered": {
      "id": 1467,
      "path": "/order/digital/delivered",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "DeliverDigital: Use this API to mark a digital order item as being delivered. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fdigital%2Fdelivered",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "digitalDeliveryReq": {
                "type": "object",
                "properties": {
                  "orders": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "order_item_list": {
                          "type": "array",
                          "items": {
                            "type": "number",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "order item list"
                          },
                          "maxItems": 100,
                          "description": "order item list"
                        },
                        "order_id": {
                          "type": "number",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "orderId"
                        }
                      },
                      "required": [
                        "order_item_list",
                        "order_id"
                      ],
                      "additionalProperties": false,
                      "description": "Batch size is limited to 20, deliver orders"
                    },
                    "maxItems": 100,
                    "description": "Batch size is limited to 20, deliver orders"
                  }
                },
                "required": [
                  "orders"
                ],
                "additionalProperties": false,
                "description": "request body"
              }
            },
            "required": [
              "digitalDeliveryReq"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "data",
            "orders",
            "*",
            "order_item_list",
            "*",
            "item_err_code"
          ],
          "name": "item_err_code",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /order/package/sof/failed_delivery": {
      "id": 1468,
      "path": "/order/package/sof/failed_delivery",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "FailedDeliveryForDBS: Use this API to mark an sof order item as being delivered failed Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fpackage%2Fsof%2Ffailed_delivery",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "dbsFailedDeliveryReq": {
                "type": "object",
                "properties": {
                  "packages": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "package_id": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "packageId"
                        }
                      },
                      "required": [
                        "package_id"
                      ],
                      "additionalProperties": false,
                      "description": "Batch size is limited to 20, packages"
                    },
                    "maxItems": 100,
                    "description": "Batch size is limited to 20, packages"
                  }
                },
                "required": [
                  "packages"
                ],
                "additionalProperties": false,
                "description": "request body"
              }
            },
            "required": [
              "dbsFailedDeliveryReq"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "data",
            "packages",
            "*",
            "item_err_code"
          ],
          "name": "item_err_code",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /order/shipment/providers/get": {
      "id": 1469,
      "path": "/order/shipment/providers/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetShipmentProvider: Use this API to get the list of all active shipping providers, which is needed when working with the PackOrder API. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fshipment%2Fproviders%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "getShipmentProvidersReq": {
                "type": "object",
                "properties": {
                  "orders": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "order_id": {
                          "type": "number",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "order_id"
                        },
                        "order_item_ids": {
                          "type": "array",
                          "items": {
                            "type": "number",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "order_item_ids"
                          },
                          "maxItems": 100,
                          "description": "order_item_ids"
                        }
                      },
                      "required": [
                        "order_id",
                        "order_item_ids"
                      ],
                      "additionalProperties": false,
                      "description": "Batch size is limited to 20, to pack orders"
                    },
                    "maxItems": 100,
                    "description": "Batch size is limited to 20, to pack orders"
                  }
                },
                "required": [
                  "orders"
                ],
                "additionalProperties": false,
                "description": "req body"
              }
            },
            "required": [
              "getShipmentProvidersReq"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /order/fulfill/pack": {
      "id": 1470,
      "path": "/order/fulfill/pack",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "Pack: Use this API to mark an order item as being packed. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Ffulfill%2Fpack",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "packReq": {
                "type": "object",
                "properties": {
                  "pack_order_list": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "order_item_list": {
                          "type": "array",
                          "items": {
                            "type": "number",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "order_item_ids that need to be packed"
                          },
                          "maxItems": 100,
                          "description": "order_item_ids that need to be packed"
                        },
                        "order_id": {
                          "type": "number",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "order that need to be packed"
                        }
                      },
                      "required": [
                        "order_item_list",
                        "order_id"
                      ],
                      "additionalProperties": false,
                      "description": "Batch size is limited to 20，Orders that need to be packed，Sub-orders of the same order will be processed together"
                    },
                    "maxItems": 20,
                    "description": "Batch size is limited to 20，Orders that need to be packed，Sub-orders of the same order will be processed together",
                    "minItems": 1
                  },
                  "delivery_type": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "dropship"
                  },
                  "shipment_provider_code": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "If it is a local store (TFs), this field cannot be transferred; If it is a cross-border store must pass (NTFS); This field cannot be transferred to DBS orders (including local stores and cross-border stores) If you want to get the available values, you can call the getshipmentprovider API"
                  },
                  "shipping_allocate_type": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "If you want to get the available values, you can call the getshipmentprovider API"
                  }
                },
                "required": [
                  "pack_order_list",
                  "delivery_type",
                  "shipping_allocate_type"
                ],
                "additionalProperties": false,
                "description": "request body"
              }
            },
            "required": [
              "packReq"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "data",
            "pack_order_list",
            "*",
            "order_item_list",
            "*",
            "item_err_code"
          ],
          "name": "item_err_code",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /order/package/sof/status/update": {
      "id": 121749,
      "path": "/order/package/sof/status/update",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "PackageStatusUpdateForDBS: DBS package status update. This interface is only open to some stores Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fpackage%2Fsof%2Fstatus%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "trackingNumber": {
                "type": "string",
                "maxLength": 262144,
                "description": "waybill no"
              },
              "source": {
                "type": "string",
                "maxLength": 262144,
                "description": "OPENAPI"
              },
              "carrierCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "SF"
              },
              "tag": {
                "type": "string",
                "maxLength": 262144,
                "description": "package no"
              },
              "trackInfo": {
                "type": "object",
                "properties": {
                  "latestStatus": {
                    "type": "object",
                    "properties": {
                      "status": {
                        "type": "string",
                        "maxLength": 262144,
                        "description": "status"
                      },
                      "subStatus": {
                        "type": "string",
                        "maxLength": 262144,
                        "description": "subStatus"
                      },
                      "subStatusDesc": {
                        "type": "string",
                        "maxLength": 262144,
                        "description": "subStatusDesc"
                      }
                    },
                    "required": [
                      "status",
                      "subStatus"
                    ],
                    "additionalProperties": false,
                    "description": "latest status"
                  },
                  "latestEvent": {
                    "type": "object",
                    "properties": {
                      "eventTime": {
                        "type": "number",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991,
                        "description": "1723012167919"
                      },
                      "description": {
                        "type": "string",
                        "maxLength": 262144,
                        "description": "description"
                      },
                      "location": {
                        "type": "string",
                        "maxLength": 262144,
                        "description": "location"
                      },
                      "stage": {
                        "type": "string",
                        "maxLength": 262144,
                        "description": "stage"
                      }
                    },
                    "required": [
                      "eventTime"
                    ],
                    "additionalProperties": false,
                    "description": "latestEvent"
                  }
                },
                "required": [
                  "latestStatus",
                  "latestEvent"
                ],
                "additionalProperties": false,
                "description": "track info"
              }
            },
            "required": [
              "trackingNumber",
              "source",
              "tag",
              "trackInfo"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "module",
          "type": "Object",
          "required": false
        },
        {
          "name": "errorCode",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /order/package/document/get": {
      "id": 1471,
      "path": "/order/package/document/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "PrintAWB: Use this API to retrieve order-related documents, only for shipping labels. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fpackage%2Fdocument%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "getDocumentReq": {
                "type": "object",
                "properties": {
                  "doc_type": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "HTML/PDF"
                  },
                  "packages": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "package_id": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "package"
                        }
                      },
                      "required": [
                        "package_id"
                      ],
                      "additionalProperties": false,
                      "description": "Batch size is limited to 20"
                    },
                    "maxItems": 100,
                    "description": "Batch size is limited to 20"
                  },
                  "print_item_list": {
                    "type": "boolean",
                    "description": "if is true, print package AWB with package item info, else no print package item info"
                  }
                },
                "required": [
                  "doc_type",
                  "packages"
                ],
                "additionalProperties": false,
                "description": "request body"
              }
            },
            "required": [
              "getDocumentReq"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /order/package/rts": {
      "id": 1472,
      "path": "/order/package/rts",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "ReadyToShip: Use this API to mark an order item as being ready to ship. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fpackage%2Frts",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "readyToShipReq": {
                "type": "object",
                "properties": {
                  "packages": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "package_id": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "packageId"
                        }
                      },
                      "required": [
                        "package_id"
                      ],
                      "additionalProperties": false,
                      "description": "Batch size is limited to 20, to readyToShip packages"
                    },
                    "maxItems": 20,
                    "description": "Batch size is limited to 20, to readyToShip packages",
                    "minItems": 1
                  }
                },
                "required": [
                  "packages"
                ],
                "additionalProperties": false,
                "description": "request body"
              }
            },
            "required": [
              "readyToShipReq"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "data",
            "packages",
            "*",
            "item_err_code"
          ],
          "name": "item_err_code",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /order/package/repack": {
      "id": 1473,
      "path": "/order/package/repack",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "RecreatePackage: Use this API to mark a package item as being repack. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Forder%2Fpackage%2Frepack",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "rePackReq": {
                "type": "object",
                "properties": {
                  "packages": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "package_id": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "packageId"
                        }
                      },
                      "required": [
                        "package_id"
                      ],
                      "additionalProperties": false,
                      "description": "Batch size is limited to 20, packages"
                    },
                    "maxItems": 100,
                    "description": "Batch size is limited to 20, packages"
                  }
                },
                "required": [
                  "packages"
                ],
                "additionalProperties": false,
                "description": "request body"
              }
            },
            "required": [
              "rePackReq"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "data",
            "packages",
            "*",
            "item_err_code"
          ],
          "name": "item_err_code",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /logistic/order/trace": {
      "id": 1336,
      "path": "/logistic/order/trace",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetOrderTrace: Query logistic detail for seller erp with seller id, order id and locale info. This api is only available in the state after ready to ship. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Flogistic%2Forder%2Ftrace",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "order id"
              },
              "locale": {
                "type": "string",
                "maxLength": 262144,
                "description": "local"
              },
              "ofcPackageIdList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "package id list"
                },
                "maxItems": 100,
                "description": "package id list"
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "not_success"
          ],
          "name": "not_success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /finance/payout/status/get": {
      "id": 1293,
      "path": "/finance/payout/status/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetPayoutStatus: Get your transaction statements created after the provided date Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffinance%2Fpayout%2Fstatus%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "created_after": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter statements created after the provided date. Mandatory."
              }
            },
            "required": [
              "created_after"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": true
        }
      ],
      "outcomes": []
    },
    "POST /finance/transaction/accountTransactions/query": {
      "id": 1283,
      "path": "/finance/transaction/accountTransactions/query",
      "method": "POST",
      "risk": "R",
      "multipart": false,
      "description": "QueryAccountTransactions: Query Account Transactions Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffinance%2Ftransaction%2FaccountTransactions%2Fquery",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "transaction_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "transaction type,Enumeration values for(Deposit,Withdrawal,Payment,null)"
              },
              "sub_transaction_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "sub transaction type,Enumeration values for(Settlement,Failed Payment,Returned Payment,Auto Withdrawal,Manual Withdrawal,Sponsored Solutions Top-up,null)"
              },
              "transaction_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "transaction number"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size"
              },
              "start_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "start time,format:yyyyMMdd"
              },
              "end_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "start time,format:yyyyMMdd"
              },
              "page_num": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page number"
              }
            },
            "required": [
              "page_size",
              "start_time",
              "end_time",
              "page_num"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "msg",
          "type": "String",
          "required": true
        },
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /lbs/slb/queryLogisticsFeeDetail": {
      "id": 1688,
      "path": "/lbs/slb/queryLogisticsFeeDetail",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "QueryLogisticsFeeDetail: Api is provided for finance and seller to query logistics fee details from slb. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Flbs%2Fslb%2FqueryLogisticsFeeDetail",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "seller_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "identity of seller which should not be blank"
              },
              "request_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "type of request which is used to distinguish different systems(e.g. OPEN_API)"
              },
              "trade_order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "identity of trade order"
              },
              "trade_order_line_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "item identity of trade order"
              },
              "fee_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "type of logistics fee"
              },
              "biz_flow_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "corresponding settlement scenario of request(e.g. LAZADA, LAZADA_3PV, default biz flow type is LAZADA)"
              },
              "bill_start_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "timestamp of the time that bill started"
              },
              "bill_end_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "timestamp of the time that bill ended"
              },
              "page_no": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "number of page which default 1"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "size of page which default 20"
              },
              "total_records": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "total records that page included"
              }
            },
            "required": [
              "seller_id",
              "request_type"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "remark",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /finance/transaction/details/get": {
      "id": 1294,
      "path": "/finance/transaction/details/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "QueryTransactionDetails: API to query seller transaction details within specific date range. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffinance%2Ftransaction%2Fdetails%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "offset": {
                "type": "string",
                "maxLength": 262144,
                "description": "Number of transaction lines to skip at the beginning of the list."
              },
              "trans_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Transaction type ID."
              },
              "trade_order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order ID."
              },
              "limit": {
                "type": "string",
                "maxLength": 262144,
                "description": "Number of lines of transactions to be extracted. The supported maximum number is 500."
              },
              "start_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Starting date when transactions need to be extracted."
              },
              "end_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Ending date when transactions need to be extracted."
              },
              "trade_order_line_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order Item ID."
              }
            },
            "required": [
              "start_time",
              "end_time"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": true
        }
      ],
      "outcomes": []
    },
    "POST /fbl/fulfillment_sku_relation/write": {
      "id": 1135,
      "path": "/fbl/fulfillment_sku_relation/write",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "BuildFulfillmentSkuRelation: build the relation between platformSku and fulfillmentSku Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_sku_relation%2Fwrite",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "site": {
                "type": "string",
                "maxLength": 262144,
                "description": "site"
              },
              "item_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "itemId"
              },
              "sku_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "skuId"
              },
              "sc_item_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "fulfillmentSkuId"
              },
              "fulfillment_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "fulfillmentSku"
              }
            },
            "required": [
              "site",
              "item_id",
              "sku_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/fulfillment_order/cancel": {
      "id": 1136,
      "path": "/fbl/fulfillment_order/cancel",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "CancelFulfillmentOrderForMCL: Cancel Fulfillment Order Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_order%2Fcancel",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "platform_order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order level identifier for fulfilment order, unique for idempotence"
              },
              "platform_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Trade platform name"
              },
              "cancel_reason": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cancelled reason"
              },
              "items": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "platform_item_id": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Unique item level identifier for fulfilment order"
                    }
                  },
                  "required": [
                    "platform_item_id"
                  ],
                  "additionalProperties": false,
                  "description": "Cancelled details"
                },
                "maxItems": 100,
                "description": "Cancelled details"
              }
            },
            "required": [
              "platform_order_id",
              "platform_name",
              "items"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/inbound_reservation/cancel": {
      "id": 1350,
      "path": "/fbl/inbound_reservation/cancel",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "CancelInboundReservation: cancel reservation order Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finbound_reservation%2Fcancel",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "reservation_order": {
                "type": "string",
                "maxLength": 262144,
                "description": "reservation order code"
              }
            },
            "required": [
              "reservation_order"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/inbound_order/cancel": {
      "id": 1137,
      "path": "/fbl/inbound_order/cancel",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "CancelnBoundOrder: Cancel inbound order Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finbound_order%2Fcancel",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "inbound_order_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inbound order number"
              }
            },
            "required": [
              "inbound_order_no"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/outbound_order/cancel": {
      "id": 251581,
      "path": "/fbl/outbound_order/cancel",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "CancelOutboundOrder: Cancel outbound order Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Foutbound_order%2Fcancel",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "outbound_order_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "Outbound order number"
              }
            },
            "required": [
              "outbound_order_no"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/vas/cancelVasOrder": {
      "id": 121999,
      "path": "/fbl/vas/cancelVasOrder",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "CancelVasOrder4FBL: 取消增值服务 Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fvas%2FcancelVasOrder",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "platform_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "laz店铺所属的前台租户,例如: LAZADA_VN"
              },
              "vas_order_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "增值服务单号"
              },
              "cancel_reason": {
                "type": "string",
                "maxLength": 262144,
                "description": "取消原因"
              }
            },
            "required": [
              "platform_name",
              "vas_order_no"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /fbl/inbound_reservation/check": {
      "id": 251582,
      "path": "/fbl/inbound_reservation/check",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "CheckInboundReservationSlot: Check Available Reservation Slots for Inbound Order Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finbound_reservation%2Fcheck",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "inbound_orders": {
                "type": "string",
                "maxLength": 262144,
                "description": "inbound order list"
              },
              "date": {
                "type": "string",
                "maxLength": 262144,
                "description": "date"
              }
            },
            "required": [
              "inbound_orders",
              "date"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/fulfillment_order/create": {
      "id": 1140,
      "path": "/fbl/fulfillment_order/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateFulfillmentOrderForMCL: Create Fulfillment Order Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_order%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "platform_payment_method": {
                "type": "string",
                "maxLength": 262144,
                "description": "Payment method, mainly check cod type"
              },
              "remark": {
                "type": "string",
                "maxLength": 262144,
                "description": "Remark"
              },
              "currency": {
                "type": "string",
                "maxLength": 262144,
                "description": "Currency"
              },
              "items": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "paid_price": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Item paid price"
                    },
                    "platform_delivery_type": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Delivery type (this is always standard for now)"
                    },
                    "platform_item_id": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Unique item level identifier for fulfilment order"
                    },
                    "sku": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Sku"
                    },
                    "owner_id": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Shipper id"
                    },
                    "shipping_type": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Distribution type (this is always warehouse)"
                    },
                    "fulfillment_sku_id": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Fulfillment sku id"
                    },
                    "quantity": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Quantity (this is always 1)"
                    },
                    "store_code": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Distribution of warehouse"
                    },
                    "unit_price": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Item unit price"
                    },
                    "warehouse_promised_time": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Warehouse promised estimated arrival time in UTC"
                    },
                    "promised_max_time": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Promised max estimated arrival time in UTC"
                    },
                    "promised_min_time": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Promised min estimated arrival time in UTC"
                    },
                    "platform_sub_trade_id": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Trade platform sub trade order id"
                    },
                    "category_name": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Item category name"
                    },
                    "fulfillment_priority": {
                      "type": "boolean",
                      "description": "Fulfillment priority"
                    }
                  },
                  "required": [
                    "paid_price",
                    "platform_delivery_type",
                    "platform_item_id",
                    "owner_id",
                    "shipping_type",
                    "fulfillment_sku_id",
                    "quantity",
                    "store_code",
                    "unit_price"
                  ],
                  "additionalProperties": false,
                  "description": "Fulfillment order line list, contains no more than 300 items"
                },
                "maxItems": 100,
                "description": "Fulfillment order line list, contains no more than 300 items"
              },
              "receiver": {
                "type": "object",
                "properties": {
                  "zip_code": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Zip code"
                  },
                  "country_iso": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "iso-3166-1 country code"
                  },
                  "country": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver country"
                  },
                  "province": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver province"
                  },
                  "city": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver city"
                  },
                  "district": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver district"
                  },
                  "town": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver town"
                  },
                  "detail_address": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver detail address"
                  },
                  "area_id": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver area id from LEL"
                  },
                  "division_id": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver division id from LEL"
                  },
                  "address_id": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver address id from LEL"
                  },
                  "mobile_phone": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver mobile phone"
                  },
                  "telephone": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver telephone"
                  },
                  "company_name": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver company name"
                  },
                  "contact_name": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver cantact name"
                  },
                  "email": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Receiver email"
                  }
                },
                "required": [
                  "country_iso",
                  "detail_address",
                  "address_id",
                  "mobile_phone",
                  "contact_name",
                  "email"
                ],
                "additionalProperties": false,
                "description": "Receiver info"
              },
              "platform_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Trade platform name"
              },
              "fulfillment_finish_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Estimated warehouse outbound time in UTC"
              },
              "platform_order_creation_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Trade order create time in UTC"
              },
              "sales_order_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sales order number from platform"
              },
              "platform_order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Unique order level identifier for fulfilment order"
              },
              "out_order_creation_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Out fulfillment order create time in UTC"
              },
              "is_platform_nominated_fleet": {
                "type": "boolean",
                "description": "Whether platform nominated fleet"
              },
              "seller_store_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "seller store id"
              },
              "seller_store_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "seller store name"
              }
            },
            "required": [
              "platform_payment_method",
              "currency",
              "items",
              "receiver",
              "platform_name",
              "platform_order_creation_time",
              "sales_order_number",
              "platform_order_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/fulfillment_order_pnf/create": {
      "id": 1141,
      "path": "/fbl/fulfillment_order_pnf/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateFulfillmentOrderForMCLV2PNF: Create Fulfillment Order for MCL2.0 PNF Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_order_pnf%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "platform_payment_method": {
                "type": "string",
                "maxLength": 262144,
                "description": "Payment method, mainly check cod type"
              },
              "remark": {
                "type": "string",
                "maxLength": 262144,
                "description": "Remark"
              },
              "currency": {
                "type": "string",
                "maxLength": 262144,
                "description": "Currency"
              },
              "items": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "paid_price": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Item paid price"
                    },
                    "platform_delivery_type": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Delivery type (this is always standard for now)"
                    },
                    "platform_item_id": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Unique item level identifier for fulfilment order"
                    },
                    "sku": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Sku"
                    },
                    "owner_id": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Shipper id"
                    },
                    "shipping_type": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Distribution type (this is always warehouse)"
                    },
                    "fulfillment_sku_id": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Fulfillment sku id"
                    },
                    "quantity": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Quantity (this is always 1)"
                    },
                    "store_code": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Distribution of warehouse"
                    },
                    "unit_price": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Item unit price"
                    },
                    "warehouse_promised_time": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Warehouse promised estimated arrival time in UTC"
                    },
                    "promised_max_time": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Promised max estimated arrival time in UTC"
                    },
                    "promised_min_time": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Promised min estimated arrival time in UTC"
                    },
                    "platform_sub_trade_id": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Trade platform sub trade order id"
                    },
                    "category_name": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Item category name"
                    },
                    "fulfillment_priority": {
                      "type": "boolean",
                      "description": "Fulfillment priority"
                    }
                  },
                  "required": [
                    "paid_price",
                    "platform_delivery_type",
                    "platform_item_id",
                    "owner_id",
                    "shipping_type",
                    "fulfillment_sku_id",
                    "quantity",
                    "store_code",
                    "unit_price"
                  ],
                  "additionalProperties": false,
                  "description": "Fulfillment order line list, contains no more than 300 items"
                },
                "maxItems": 100,
                "description": "Fulfillment order line list, contains no more than 300 items"
              },
              "platform_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Trade platform name"
              },
              "fulfillment_finish_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Estimated warehouse outbound time in UTC"
              },
              "platform_order_creation_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Trade order create time in UTC"
              },
              "sales_order_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sales order number from platform"
              },
              "platform_order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Unique order level identifier for fulfilment order"
              },
              "out_order_creation_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Out fulfillment order create time in UTC"
              },
              "seller_store_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "seller store id"
              },
              "seller_store_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "seller store name"
              }
            },
            "required": [
              "platform_payment_method",
              "currency",
              "items",
              "platform_name",
              "platform_order_creation_time",
              "sales_order_number",
              "platform_order_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/fulfillment_sku/create": {
      "id": 1412,
      "path": "/fbl/fulfillment_sku/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateFulfillmentSkuDecouple: create fulfillment sku without product Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_sku%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "fulfillment_sku_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "title"
              },
              "barcodes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "barcode list"
                },
                "maxItems": 100,
                "description": "barcode list"
              },
              "hygroscopic": {
                "type": "boolean",
                "description": "true/false"
              },
              "precious": {
                "type": "boolean",
                "description": "true/false"
              },
              "product_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "food,liquid,danger,other"
              },
              "temperature_requirement": {
                "type": "string",
                "maxLength": 262144,
                "description": "1: normal temperature 4: refrigerated 6: frozen"
              },
              "pic_urls": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "at most 6 pictures url"
                },
                "maxItems": 100,
                "description": "at most 6 pictures url"
              },
              "serial_number_flag": {
                "type": "boolean",
                "description": "true/false"
              },
              "shelf_life_flag": {
                "type": "boolean",
                "description": "true/false"
              },
              "shelf_life_days": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "required if shelf_life_day is life_mgnt"
              },
              "reject_shelf_live": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "required if shelf_life_day is life_mgnt"
              },
              "alert_shelf_live": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "required if shelf_life_day is life_mgnt"
              },
              "offline_shelf_live": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "required if shelf_life_day is life_mgnt"
              },
              "seller_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "erp sku code"
              },
              "sale_price": {
                "type": "string",
                "maxLength": 262144,
                "description": "sale price"
              },
              "length": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "length(mm)"
              },
              "width": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "width(mm)"
              },
              "height": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "height(mm)"
              },
              "weight": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "weight(g)"
              }
            },
            "required": [
              "fulfillment_sku_name",
              "barcodes",
              "hygroscopic",
              "precious",
              "product_type",
              "temperature_requirement",
              "pic_urls",
              "serial_number_flag",
              "shelf_life_flag",
              "seller_sku",
              "sale_price"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /fbl/fulfillment_sku_fbl/create": {
      "id": 251583,
      "path": "/fbl/fulfillment_sku_fbl/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateFulfillmentSkuForFBL: create fulfillment sku for specified platform product Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_sku_fbl%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "sku_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "platform sku sku_id"
              },
              "barcodes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "barcode list"
                },
                "maxItems": 100,
                "description": "barcode list"
              },
              "hygroscopic": {
                "type": "boolean",
                "description": "is product hygroscopic?"
              },
              "product_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "food / liquid / danger / other"
              },
              "temperature_requirement": {
                "type": "string",
                "maxLength": 262144,
                "description": "\"1\": normal temperature \"4\": refrigerated \"6\": frozen"
              },
              "serial_number_flag": {
                "type": "boolean",
                "description": "is serial number management enabled?"
              },
              "shelf_life_flag": {
                "type": "boolean",
                "description": "is shelf life management enabled?"
              },
              "shelf_life_days": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "days of shelf life, required if shelf_life_flag is true."
              },
              "reject_shelf_live": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "days to reject at inbound before expiry, required if shelf_life_flag is true."
              },
              "alert_shelf_live": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "days to alert before expiry, required if shelf_life_flag is true."
              },
              "offline_shelf_live": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "days to take offline before expiry, required if shelf_life_flag is true."
              }
            },
            "required": [
              "sku_id",
              "barcodes",
              "hygroscopic",
              "product_type",
              "temperature_requirement",
              "serial_number_flag",
              "shelf_life_flag"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/inbound_order/create": {
      "id": 1389,
      "path": "/fbl/inbound_order/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateInboundOrder: Create inbound order Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finbound_order%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "warehouse_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inbound warehouse code."
              },
              "delivery_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Delivery type,Enum: Dropoff / Pickup."
              },
              "seller_warehouse_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Seller warehouse code. Default value is seller's first sellerWarehouse, usually it's seller's address in asc. You can get the warehouse list by openApi listIcpWarehouse."
              },
              "estimate_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Estimated Arrival Time in UTC+0. format is \"yyyy-MM-ddTHH:mm:ssZ\"."
              },
              "comment": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inbound comment."
              },
              "reference_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Reference number."
              },
              "skus": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "seller_sku": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Seller sku."
                    },
                    "fulfillment_sku": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Fulfillment sku code. You should use at least one of params seller_sku and fulfillment_sku. If you send them both, we will use fulfillment_sku to find your sku and ignore param seller_sku."
                    },
                    "requested_quantity": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Requested inbound quantity. The quantity must be greater than 0."
                    }
                  },
                  "required": [
                    "requested_quantity"
                  ],
                  "additionalProperties": false,
                  "description": "List of inbound skus. Max list size is 100."
                },
                "maxItems": 100,
                "description": "List of inbound skus. Max list size is 100."
              }
            },
            "required": [
              "warehouse_code",
              "estimate_time",
              "skus"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "inbound_order_no",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/inbound_reservation/create": {
      "id": 1399,
      "path": "/fbl/inbound_reservation/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateInboundReservation: create reservation order Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finbound_reservation%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "inbound_orders": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "inbound order list"
                },
                "maxItems": 100,
                "description": "inbound order list"
              },
              "slot": {
                "type": "string",
                "maxLength": 262144,
                "description": "reserve slot"
              }
            },
            "required": [
              "inbound_orders",
              "slot"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Object",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        },
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/outbound_order/create": {
      "id": 1398,
      "path": "/fbl/outbound_order/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateOutBoundOrder: Create outbound order Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Foutbound_order%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "reference_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Reference number."
              },
              "warehouse_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "outbound warehouse code."
              },
              "delivery_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Delivery type,Enum: Dropoff / Pickup."
              },
              "seller_warehouse_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Seller warehouse code. Default value is seller's first sellerWarehouse, usually it's seller's address in asc. You can get the warehouse list by openApi listIcpWarehouse."
              },
              "estimate_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Estimated Time in UTC+0. format is \"yyyy-MM-ddTHH:mm:ssZ\"."
              },
              "comment": {
                "type": "string",
                "maxLength": 262144,
                "description": "Outbound comment."
              },
              "inventory_type": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Inventory type, 1 for good, 101 for defective, 137 for Damaged A, 138 for Damaged B, 140 for Damaged C"
              },
              "skus": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "fulfillment_sku": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Fulfillment sku code. You should use at least one of params seller_sku and fulfillment_sku. If you send them both, we will use fulfillment_sku to find your sku and ignore param seller_sku."
                    },
                    "requested_quantity": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Request outbound quantity.The quantity must be greater than 0."
                    },
                    "seller_sku": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Seller sku."
                    }
                  },
                  "required": [
                    "requested_quantity"
                  ],
                  "additionalProperties": false,
                  "description": "List of outbound skus. Max list size is 100."
                },
                "maxItems": 100,
                "description": "List of outbound skus. Max list size is 100."
              }
            },
            "required": [
              "warehouse_code",
              "estimate_time",
              "inventory_type",
              "skus"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "outbound_order_no",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/product_reinbound/create": {
      "id": 1391,
      "path": "/fbl/product_reinbound/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateProductReinboundOrderForMCL: Create Product Reinbound Order on Failed Delivery for MCL Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fproduct_reinbound%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "platform_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Trade platform name"
              },
              "sales_order_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sales order number from platform"
              },
              "platform_order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Unique order level identifier for fulfilment order"
              },
              "reinbound_order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Package level identifier for product reinbound request, unique for idempotence"
              },
              "tracking_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Tracking number for original package"
              },
              "reason": {
                "type": "string",
                "maxLength": 262144,
                "description": "Failed delivery reason"
              }
            },
            "required": [
              "platform_name",
              "sales_order_number",
              "platform_order_id",
              "reinbound_order_id",
              "tracking_number"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/vas/createVasOrder": {
      "id": 251584,
      "path": "/fbl/vas/createVasOrder",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateVasOrder4FBL: FBL增值服务创建 Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fvas%2FcreateVasOrder",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "platform_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "laz店铺所属的前台租户,例如: LAZADA_VN"
              },
              "idempotent_key": {
                "type": "string",
                "maxLength": 262144,
                "description": "幂等码"
              },
              "service_provider_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "物流服务商单据号，比如：LBX"
              },
              "target_order_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "服务目标单据号,比如：CO单号"
              },
              "target_order_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "服务对象类型：服务对象为入库单，则填写：CO；服务对象为品，则填写:GOODS;"
              },
              "vas_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "增值服务Code：LABEL_PRINTING_PASTING_FOR_IB 打印并贴商品条码 LABEL_PRINTING_PASTING_FOR_ITEM 打印并贴商品条码 REPACKING_FOR_IB 重新包装 REPACKING_FOR_ITEM 重新包装 BUNDLING 绑定商品 LABEL_PRINTING_FOR_IB 打印商品条码 LABEL_PRINTING_FOR_ITEM 打印商品条码 LABEL_PASTING_FOR_IB 贴商品条码 LABEL_PASTING_FOR_ITEM 贴商品条码 SORTING 分类商品 INBOUND_QC 收货质检"
              },
              "warehouse_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "仓code"
              },
              "lines": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "quantity": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "计划数量"
                    },
                    "scItem_id": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "货品ID"
                    },
                    "bundle_quantity": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "绑定数量"
                    }
                  },
                  "required": [
                    "quantity",
                    "scItem_id"
                  ],
                  "additionalProperties": false,
                  "description": "明细行"
                },
                "maxItems": 100,
                "description": "明细行"
              }
            },
            "required": [
              "platform_name",
              "idempotent_key",
              "vas_code",
              "warehouse_code",
              "lines"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /fbl/channel_stocks/get": {
      "id": 251585,
      "path": "/fbl/channel_stocks/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetChannelStocksForMCL: Query Channel Stocks Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fchannel_stocks%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "platform_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Platform Name"
              },
              "fulfillment_sku_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Fulfillment Sku ID"
              },
              "warehouse_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Warehouse Code"
              }
            },
            "required": [
              "platform_name",
              "fulfillment_sku_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/fulfillment_products/get": {
      "id": 251586,
      "path": "/fbl/fulfillment_products/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetFulfillmentProductDetail: GET fulfillment product Detail；Call Get Platform Products for fulfillment_sku first Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_products%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "per_page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Maximum number of results per page"
              },
              "shelf_life_flag": {
                "type": "boolean",
                "description": "Serial number flag. true or false"
              },
              "marketplace": {
                "type": "string",
                "maxLength": 262144,
                "description": "Marketplace should be \"LAZADA_MY\",\"LAZADA_ID\",\"LAZADA_VN\",\"LAZADA_SG\",\"LAZADA_TH\",\"LAZADA_PH\""
              },
              "fulfillment_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "Fulfillment SKU"
              },
              "serial_number_flag": {
                "type": "boolean",
                "description": "Serial number flag. true or false"
              },
              "page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page"
              },
              "fulfillment_sku_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Fulfillment SKU Name used in Lazada fulfilment system"
              },
              "barcode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Barcode"
              }
            },
            "required": [
              "marketplace"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /fbl/fulfillment_sku_list/get": {
      "id": 1392,
      "path": "/fbl/fulfillment_sku_list/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetFulfillmentSkuListForMCL: Get Fulfillment SKU List for LAZADA Partner Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_sku_list%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page Index"
              },
              "per_page": {
                "type": "string",
                "maxLength": 262144,
                "description": "Maximum number of results per page"
              },
              "platform_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Platform name"
              },
              "fulfillment_sku_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Fulfillment Sku Name"
              },
              "seller_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "Seller Sku"
              },
              "fulfillment_sku_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Fulfillment Sku Code"
              },
              "barcode": {
                "type": "string",
                "maxLength": 262144,
                "description": "barcode"
              },
              "fulfillment_sku_codes": {
                "type": "string",
                "maxLength": 262144,
                "description": "Fulfillment Sku Codes"
              }
            },
            "required": [
              "page",
              "per_page",
              "platform_name"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "page",
          "type": "Number",
          "required": false
        },
        {
          "name": "per_page",
          "type": "Number",
          "required": false
        },
        {
          "name": "total_count",
          "type": "Number",
          "required": false
        },
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/fulfillment_sku_relation/get_by_sc_item": {
      "id": 251587,
      "path": "/fbl/fulfillment_sku_relation/get_by_sc_item",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetFulfillmentSkuRelationByScItem: get the relation between platformSku and fulfillmentSku by scItem Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_sku_relation%2Fget_by_sc_item",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "site": {
                "type": "string",
                "maxLength": 262144,
                "description": "site"
              },
              "sc_item_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "scItemId/fulfillment_sku_id"
              },
              "fulfillment_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "fulfillment_sku"
              }
            },
            "required": [
              "site"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /fbl/fulfillment_sku_relation/get_by_sku": {
      "id": 251588,
      "path": "/fbl/fulfillment_sku_relation/get_by_sku",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetFulfillmentSkuRelationBySku: get the relation between platformSku and fulfillmentSku by sku Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_sku_relation%2Fget_by_sku",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "site": {
                "type": "string",
                "maxLength": 262144,
                "description": "site"
              },
              "item_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "itemId"
              },
              "sku_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "skuId"
              }
            },
            "required": [
              "site",
              "item_id",
              "sku_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /fbl/fulfillment_sku_relation/get_by_sc_items": {
      "id": 1414,
      "path": "/fbl/fulfillment_sku_relation/get_by_sc_items",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetFulfillmentSkuRelationsByScItems: get fulfillmentSku Relations By ScItems Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_sku_relation%2Fget_by_sc_items",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "biz_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "bizName"
              },
              "seller_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "sellerIds"
                },
                "maxItems": 100,
                "description": "sellerIds"
              },
              "sc_item_ids": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "scItemIds"
                },
                "maxItems": 100,
                "description": "scItemIds"
              },
              "fulfillment_skus": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "fulfillmentSkus"
                },
                "maxItems": 100,
                "description": "fulfillmentSkus"
              }
            },
            "required": [
              "biz_name",
              "seller_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /fbl/fulfillment_sku_relation/get_by_skus": {
      "id": 1410,
      "path": "/fbl/fulfillment_sku_relation/get_by_skus",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetFulfillmentSkuRelationsBySkus: get fulfillmentSku Relations By Skus Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_sku_relation%2Fget_by_skus",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "site": {
                "type": "string",
                "maxLength": 262144,
                "description": "site"
              },
              "item_sku": {
                "type": "object",
                "properties": {
                  "item_ids": {
                    "type": "array",
                    "items": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "item_ids"
                    },
                    "maxItems": 100,
                    "description": "item_ids"
                  },
                  "sku_ids": {
                    "type": "array",
                    "items": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "sku_ids"
                    },
                    "maxItems": 100,
                    "description": "sku_ids"
                  }
                },
                "required": [
                  "item_ids",
                  "sku_ids"
                ],
                "additionalProperties": false,
                "description": "obj"
              }
            },
            "required": [
              "site",
              "item_sku"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /fbl/icp_order/file": {
      "id": 251589,
      "path": "/fbl/icp_order/file",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetIcpOrderFile: Get Inbound/Outbound order print PDF file Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ficp_order%2Ffile",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "order_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inbound/Outbound order number"
              }
            },
            "required": [
              "order_number"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Object",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        },
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/inbound_order_detail/get": {
      "id": 251590,
      "path": "/fbl/inbound_order_detail/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetInboundOrderDetail: Use this API to get the Inbound Order Detail Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finbound_order_detail%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "inbound_order_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inbound ouder number"
              },
              "marketplace": {
                "type": "string",
                "maxLength": 262144,
                "description": "Enum Value:LAZADA_VN,LAZADA_SG,LAZADA_MY, LAZADA_ID,LAZADA_PH,LAZADA_TH"
              }
            },
            "required": [
              "inbound_order_no",
              "marketplace"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /fbl/inbound_orders/get": {
      "id": 251591,
      "path": "/fbl/inbound_orders/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetInboundOrderList: Use this API to get inbound order list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finbound_orders%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "inbound_order_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inbound order number, Multi orders split by ','. Max size is 100"
              },
              "creation_time_From": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order's create time from"
              },
              "creation_time_To": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order's create time end"
              },
              "inbound_warehouse": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inbound warehouse name"
              },
              "seller_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "seller sku name"
              },
              "fulfillment_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "Fulfilment SKU code"
              },
              "marketplace": {
                "type": "string",
                "maxLength": 262144,
                "description": "marketplace:LAZADA_VN,LAZADA_SG,LAZADA_MY, LAZADA_ID,LAZADA_PH,LAZADA_TH"
              },
              "page": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order list page index"
              },
              "per_page": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order list per page size, Max is 100"
              },
              "reservation_status": {
                "type": "string",
                "maxLength": 262144,
                "description": "ReservationStatus: PENDING_RESERVATION_ORDER_CREATE | RESERVATION_ORDER_CREATED | RESERVED |ARRIVED. PENDING_RESERVATION_ORDER_CREATE"
              },
              "reservation_order": {
                "type": "string",
                "maxLength": 262144,
                "description": "Reservation Order number"
              },
              "reference_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Reference number"
              }
            },
            "required": [
              "marketplace"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /fbl/inbound_reservation/file": {
      "id": 1405,
      "path": "/fbl/inbound_reservation/file",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetInboundReservationFile: get inbound reservation order file Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finbound_reservation%2Ffile",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "reservation_order": {
                "type": "string",
                "maxLength": 262144,
                "description": "reservation order code"
              }
            },
            "required": [
              "reservation_order"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/inventory_changed_sku/get": {
      "id": 1406,
      "path": "/fbl/inventory_changed_sku/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetInventoryChangedSKU: Use this API to get SKU list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finventory_changed_sku%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "warehouse_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Warehouse code"
              },
              "page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Sku list page index"
              },
              "per_page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Sku list per page size"
              },
              "market_place": {
                "type": "string",
                "maxLength": 262144,
                "description": "market place:LAZADA_VN,LAZADA_SG,LAZADA_MY, LAZADA_ID,LAZADA_PH,LAZADA_TH"
              },
              "operate_Time_From": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inventory operate time from. This param is Required"
              },
              "operate_Time_To": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inventory operate time to. This param is Required.We suggest that operate_time_to - operate_time_from < 6 months"
              }
            },
            "required": [
              "market_place"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "per_page",
          "type": "Number",
          "required": false
        },
        {
          "name": "page",
          "type": "Number",
          "required": false
        },
        {
          "name": "total_count",
          "type": "Number",
          "required": false
        },
        {
          "name": "sku_list",
          "type": "Object[]",
          "required": false
        },
        {
          "name": "success",
          "type": "String",
          "required": false
        },
        {
          "name": "errMessage",
          "type": "String",
          "required": false
        },
        {
          "name": "errCode",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/inventory_occupy_details/get": {
      "id": 1746,
      "path": "/fbl/inventory_occupy_details/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetInventoryOccupyDetails: Use this API to get a sku's inventory occupy details Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finventory_occupy_details%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "fulfillmentSku": {
                "type": "string",
                "maxLength": 262144,
                "description": "Fulfillment Sku Id"
              },
              "storeCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Warehouse code"
              },
              "marketplace": {
                "type": "string",
                "maxLength": 262144,
                "description": "market place:LAZADA_VN,LAZADA_SG,LAZADA_MY, LAZADA_ID,LAZADA_PH,LAZADA_TH"
              },
              "pageNum": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "pageNum"
              },
              "pageSize": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "pageSize"
              }
            },
            "required": [
              "fulfillmentSku",
              "storeCode",
              "marketplace"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "inventoryOccupyDetails",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /fbl/inventory_operate_log/get": {
      "id": 251592,
      "path": "/fbl/inventory_operate_log/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetInventoryOperateLog: Use this API to get a sku's inventory operate log Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finventory_operate_log%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Operate log list page index"
              },
              "per_page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Operate log list perpage size"
              },
              "market_place": {
                "type": "string",
                "maxLength": 262144,
                "description": "market place:LAZADA_VN,LAZADA_SG,LAZADA_MY, LAZADA_ID,LAZADA_PH,LAZADA_TH"
              },
              "operate_time_from": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inventory operate time from, GMT+0."
              },
              "operate_time_to": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inventory operate time to, GMT+0. This param is Required. We suggest that operate_time_to - operate_time_from < 6 months"
              },
              "warehouse_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Warehouse code"
              },
              "fulfillment_sku_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Fulfillment Sku Id"
              },
              "order_type_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order Type Code"
              }
            },
            "required": [
              "market_place"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "inventory_operate_log",
          "type": "Object[]",
          "required": false
        },
        {
          "name": "success",
          "type": "String",
          "required": false
        },
        {
          "name": "errMessage",
          "type": "String",
          "required": false
        },
        {
          "name": "errCode",
          "type": "String",
          "required": false
        },
        {
          "name": "page",
          "type": "Number",
          "required": false
        },
        {
          "name": "per_page",
          "type": "Number",
          "required": false
        },
        {
          "name": "total_count",
          "type": "Number",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/outbound_order_detail/get": {
      "id": 251593,
      "path": "/fbl/outbound_order_detail/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetOutboundOrderDetail: Use this API to Get outbound order detail; shoud call GetOutboundOrderList for outbound_order_no first Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Foutbound_order_detail%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "outbound_order_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "order number"
              },
              "marketplace": {
                "type": "string",
                "maxLength": 262144,
                "description": "Enum Value:LAZADA_VN,LAZADA_SG,LAZADA_MY, LAZADA_ID,LAZADA_PH,LAZADA_TH"
              }
            },
            "required": [
              "outbound_order_no",
              "marketplace"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /fbl/outbound_orders/get": {
      "id": 251594,
      "path": "/fbl/outbound_orders/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetOutboundOrderList: Use this API to get outbound order list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Foutbound_orders%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "outbound_order_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "Outbound order number,Multi orders split by ','. Max size is 100"
              },
              "creation_time_from": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order's create time from"
              },
              "creation_time_to": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order's create time end"
              },
              "outbound_warehouse": {
                "type": "string",
                "maxLength": 262144,
                "description": "Outbound warehouse name"
              },
              "seller_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "seller sku name"
              },
              "fulfillment_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "Fulfilment SKU code"
              },
              "marketplace": {
                "type": "string",
                "maxLength": 262144,
                "description": "marketplace:LAZADA_VN,LAZADA_SG,LAZADA_MY, LAZADA_ID,LAZADA_PH,LAZADA_TH"
              },
              "page": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order list page index"
              },
              "per_page": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order list per page size"
              },
              "reference_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Reference number"
              }
            },
            "required": [
              "marketplace"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /fbl/platform_products/get2": {
      "id": 251595,
      "path": "/fbl/platform_products/get2",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetPlatformProductsV2: Search products list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fplatform_products%2Fget2",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "per_page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Maximum number of results Per Page"
              },
              "seller_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "sellerId"
              },
              "marketplace": {
                "type": "string",
                "maxLength": 262144,
                "description": "Marketplace"
              },
              "seller_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "sellerSku"
              },
              "platform_sku_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Platform SKU Name"
              },
              "ready_for_inbound": {
                "type": "boolean",
                "description": "Products that have binding stock in warsehouse"
              },
              "platform_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "List of Platform SKU. Separate By Comma (,)"
              },
              "page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page Number"
              }
            },
            "required": [
              "seller_id",
              "marketplace"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /fbl/product_batch/query": {
      "id": 156571,
      "path": "/fbl/product_batch/query",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetProductBatchList: query product batch list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fproduct_batch%2Fquery",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "productBatchListRequest": {
                "type": "object",
                "properties": {
                  "fulfillment_sku_ids": {
                    "type": "array",
                    "items": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "fulfillment sku ids"
                    },
                    "maxItems": 100,
                    "description": "fulfillment sku ids"
                  },
                  "shipper_id": {
                    "type": "number",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991,
                    "description": "shipper id"
                  },
                  "page_no": {
                    "type": "number",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991,
                    "description": "page no"
                  },
                  "page_size": {
                    "type": "number",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991,
                    "description": "page size"
                  },
                  "store_code": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "store code"
                  }
                },
                "required": [
                  "fulfillment_sku_ids",
                  "shipper_id",
                  "page_no",
                  "page_size",
                  "store_code"
                ],
                "additionalProperties": false,
                "description": "request body"
              }
            },
            "required": [
              "productBatchListRequest"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/shipper/get": {
      "id": 251596,
      "path": "/fbl/shipper/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetShipperInfo: Get Shipper Info for LAZADA Partner Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fshipper%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Object",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/stock_rule/get": {
      "id": 251597,
      "path": "/fbl/stock_rule/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetStockRule: Get SKU stock rule by sku and warehouse Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fstock_rule%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "fulfillment_sku_ids": {
                "type": "string",
                "maxLength": 262144,
                "description": "fulfilment sku id list"
              },
              "store_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "warehouse code"
              },
              "page": {
                "type": "string",
                "maxLength": 262144,
                "description": "page index, default: 1"
              },
              "per_page": {
                "type": "string",
                "maxLength": 262144,
                "description": "page size, default: 50"
              }
            },
            "required": [
              "store_code"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "String",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "page",
          "type": "Number",
          "required": false
        },
        {
          "name": "per_page",
          "type": "Number",
          "required": false
        },
        {
          "name": "total_count",
          "type": "Number",
          "required": false
        },
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/vas/getVasOrderByNo": {
      "id": 251598,
      "path": "/fbl/vas/getVasOrderByNo",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetVasOrderByNo4FBL: get vasOrder by orderNo Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fvas%2FgetVasOrderByNo",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "platform_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "laz店铺所属的前台租户,例如: LAZADA_VN"
              },
              "vas_order_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "增值服务单号"
              }
            },
            "required": [
              "platform_name",
              "vas_order_code"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /fbl/warehouses/get": {
      "id": 251599,
      "path": "/fbl/warehouses/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetWarehouseListForMCL: Get Warehouse List By Country And Multi-Channel Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fwarehouses%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "country_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "CountryCode"
              },
              "page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "PageIndex"
              },
              "per_page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Maximum number of results per page"
              }
            },
            "required": [
              "country_code",
              "page",
              "per_page"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "page",
          "type": "Number",
          "required": false
        },
        {
          "name": "per_page",
          "type": "Number",
          "required": false
        },
        {
          "name": "total_count",
          "type": "Number",
          "required": false
        },
        {
          "name": "total_page",
          "type": "Number",
          "required": false
        },
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/stocks/get": {
      "id": 1415,
      "path": "/fbl/stocks/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetWarehouseStock: Get SKU list and stock by warehouse code Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fstocks%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "seller_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "Seller SKU"
              },
              "marketplace": {
                "type": "string",
                "maxLength": 262144,
                "description": "Marketplace should be \"LAZADA_MY\",\"LAZADA_ID\",\"LAZADA_VN\",\"LAZADA_SG\",\"LAZADA_TH\",\"LAZADA_PH\""
              },
              "fulfilment_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "List of shop SKU, Comma separated list in square brackets"
              },
              "store_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Warehouse Code List：https://www.yuque.com/u1990121/kb/exh5go#B4gg"
              }
            },
            "required": [
              "marketplace"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /fbl/stocks/getV3": {
      "id": 251600,
      "path": "/fbl/stocks/getV3",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetWarehouseStockV3: Get SKU list and stock by warehouse code, this version separates pending inbound and stock in transit in return json. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fstocks%2FgetV3",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "seller_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "Seller SKU, required when fulfilment_sku is empty"
              },
              "marketplace": {
                "type": "string",
                "maxLength": 262144,
                "description": "Marketplace should be \"LAZADA_MY\",\"LAZADA_ID\",\"LAZADA_VN\",\"LAZADA_SG\",\"LAZADA_TH\",\"LAZADA_PH\""
              },
              "fulfilment_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "List of shop SKU, Comma separated list in square brackets, required when seller_sku is empty"
              },
              "store_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Warehouse Code List：https://www.yuque.com/u1990121/kb/exh5go#B4gg"
              }
            },
            "required": [
              "marketplace"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /fbl/icp_warehouse/list": {
      "id": 1352,
      "path": "/fbl/icp_warehouse/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "ListIcpWarehouse: List warehouses for create InboundOrder and outboundOrder Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ficp_warehouse%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "warehouse_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Warehouse type. Enum: Inbound | outbound | Seller"
              }
            },
            "required": [
              "warehouse_type"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/fulfillment_order_list/get": {
      "id": 251601,
      "path": "/fbl/fulfillment_order_list/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "QueryFulfillmentOrderForMCL: Query list of Fulfillment Orders by shipper Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_order_list%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "platform_order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order level identifier for fulfilment order, unique for idempotence"
              },
              "platform_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Trade platform name"
              },
              "per_page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page size"
              },
              "page": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page index"
              },
              "sales_order_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sales order number from platform"
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "Status"
              },
              "create_start_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order create time lower bound"
              },
              "create_end_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Order create time upper bound"
              },
              "delivery_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Delivery type"
              }
            },
            "required": [
              "platform_name",
              "per_page",
              "page",
              "create_start_time",
              "create_end_time"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "per_page",
          "type": "Number",
          "required": false
        },
        {
          "name": "page",
          "type": "Number",
          "required": false
        },
        {
          "name": "total_count",
          "type": "Number",
          "required": false
        },
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/inbound_batch/query": {
      "id": 156572,
      "path": "/fbl/inbound_batch/query",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "QueryInboundBatch: query inbound batch Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finbound_batch%2Fquery",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "query_request": {
                "type": "object",
                "properties": {
                  "inbound_order": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "inbound order"
                  },
                  "shipper_id": {
                    "type": "number",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991,
                    "description": "shipper id"
                  },
                  "store_code": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "store code"
                  }
                },
                "required": [
                  "inbound_order",
                  "shipper_id",
                  "store_code"
                ],
                "additionalProperties": false,
                "description": "request body"
              }
            },
            "required": [
              "query_request"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/inbound_reservation/get": {
      "id": 1404,
      "path": "/fbl/inbound_reservation/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "QueryInboundReservationOrder: get inbound reservation order Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Finbound_reservation%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "reservation_order": {
                "type": "string",
                "maxLength": 262144,
                "description": "reservation order"
              },
              "inbound_order": {
                "type": "string",
                "maxLength": 262144,
                "description": "Inbound Order ID, required when reservation order is not present. if reservation order is present, use reservation order first"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /fbl/reverse_order/get": {
      "id": 251602,
      "path": "/fbl/reverse_order/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "QueryReverseOrderForMCL: Query Reverse Order for MCL Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Freverse_order%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "sales_order_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sales order number from platform"
              }
            },
            "required": [
              "sales_order_number"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/fulfillment_sku_relation/remove": {
      "id": 1397,
      "path": "/fbl/fulfillment_sku_relation/remove",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "RemoveFulfillmentSkuRelation: remove the relation between platformSku and fulfillmentSku Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_sku_relation%2Fremove",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "site": {
                "type": "string",
                "maxLength": 262144,
                "description": "site"
              },
              "item_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "itemId"
              },
              "sku_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "skuId"
              },
              "sc_item_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "fulfillmentSkuId"
              },
              "fulfillment_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "fulfillmentSku"
              }
            },
            "required": [
              "site",
              "item_id",
              "sku_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/returns/cancel": {
      "id": 1408,
      "path": "/fbl/returns/cancel",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "ReturnCancellation: Return order cancellation Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Freturns%2Fcancel",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "return_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "return id created during return order creation"
              }
            },
            "required": [
              "return_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/returns/create": {
      "id": 1396,
      "path": "/fbl/returns/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "ReturnOrderCreation: Api to create customer returns Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Freturns%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "tracking": {
                "type": "object",
                "properties": {
                  "origin": {
                    "type": "object",
                    "properties": {
                      "location": {
                        "type": "object",
                        "properties": {
                          "address": {
                            "type": "string",
                            "maxLength": 262144,
                            "description": "Address"
                          },
                          "address_id": {
                            "type": "string",
                            "maxLength": 262144,
                            "description": "Address ID"
                          },
                          "details": {
                            "type": "string",
                            "maxLength": 262144,
                            "description": "Additional details of the location"
                          }
                        },
                        "required": [
                          "address",
                          "address_id"
                        ],
                        "additionalProperties": false,
                        "description": "location"
                      }
                    },
                    "required": [
                      "location"
                    ],
                    "additionalProperties": false,
                    "description": "origin"
                  },
                  "tracking_number": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Tracking Number"
                  }
                },
                "required": [
                  "origin",
                  "tracking_number"
                ],
                "additionalProperties": false,
                "description": "tracking"
              },
              "platform_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Platform Name"
              },
              "platform_order_creation_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sales order creation time of platform side Datetime format: 2017-11-17T10:14:13.185Z"
              },
              "return_comment": {
                "type": "string",
                "maxLength": 262144,
                "description": "Customer comments accompanying the return order, will be used as reference during quality check"
              },
              "return_delivery_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Return delivery type (always return_by_customer)"
              },
              "return_order_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Return order number from platform; must be unique"
              },
              "sales_order_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sales order number accompanying the original fulfilment order request"
              },
              "currency": {
                "type": "string",
                "maxLength": 262144,
                "description": "Currency"
              },
              "customer": {
                "type": "object",
                "properties": {
                  "phone": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Customer phone"
                  },
                  "email": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Customer email"
                  },
                  "name": {
                    "type": "string",
                    "maxLength": 262144,
                    "description": "Customer name"
                  }
                },
                "required": [
                  "phone",
                  "name"
                ],
                "additionalProperties": false,
                "description": "customer info"
              },
              "platform_order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Return order id - unique order level Identifier used to send return order and item status notification events"
              },
              "parcel": {
                "type": "object",
                "properties": {
                  "items": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "name": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Item name"
                        },
                        "paid_price": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Paid Price Minimum value : 0"
                        },
                        "platform_item_id": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Return item id - unique item level Identifier used to send return item status notification events"
                        },
                        "quantity": {
                          "type": "number",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Quantity Minimum value : 1"
                        },
                        "return_reason": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Return reason (please refer to list of return reasons below)"
                        },
                        "return_type": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Return Type (always normal)"
                        },
                        "seller_return_policy": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Seller return policy (free text)"
                        },
                        "sku": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Fulfillment SKU id"
                        },
                        "unit_price": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Price of a single unit Minimum value : 0"
                        },
                        "weight": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Weight of a single unit in grams Minimum value : 0"
                        },
                        "width": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Width in cm Minimum value : 0"
                        },
                        "delivery_package_id": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Package indentifier used to deliver original sales order item to customer"
                        },
                        "fulfillment_type": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Fulfillment type (always MCL)"
                        },
                        "height": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Height in cm. Minimum value : 0"
                        },
                        "length": {
                          "type": "string",
                          "maxLength": 262144,
                          "description": "Length in cm. Minimum value : 0"
                        }
                      },
                      "required": [
                        "name",
                        "platform_item_id",
                        "quantity",
                        "return_reason",
                        "return_type",
                        "seller_return_policy",
                        "sku",
                        "unit_price",
                        "weight",
                        "width",
                        "delivery_package_id",
                        "fulfillment_type",
                        "height",
                        "length"
                      ],
                      "additionalProperties": false,
                      "description": "items"
                    },
                    "maxItems": 100,
                    "description": "items"
                  }
                },
                "required": [
                  "items"
                ],
                "additionalProperties": false,
                "description": "parcel"
              }
            },
            "required": [
              "tracking",
              "platform_name",
              "platform_order_creation_time",
              "return_comment",
              "return_delivery_type",
              "return_order_number",
              "sales_order_number",
              "currency",
              "customer",
              "platform_order_id",
              "parcel"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/stock_rule/set": {
      "id": 251603,
      "path": "/fbl/stock_rule/set",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "SetStockRule: set channel ratio by sku and warehouse Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fstock_rule%2Fset",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "skus": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "fulfillment_sku_id": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "fulfillment sku id"
                    },
                    "store_code": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "warehouse code"
                    },
                    "ratio": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "ratio"
                    },
                    "auto_balancing": {
                      "type": "boolean",
                      "description": "enable auto-balancing between channels"
                    }
                  },
                  "required": [
                    "fulfillment_sku_id",
                    "store_code",
                    "ratio",
                    "auto_balancing"
                  ],
                  "additionalProperties": false,
                  "description": "skus"
                },
                "maxItems": 100,
                "description": "skus"
              }
            },
            "required": [
              "skus"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /fbl/fulfillment_sku/update": {
      "id": 251605,
      "path": "/fbl/fulfillment_sku/update",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "UpdateFulfillmentSkuDecouple: update fulfillment sku without product Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Ffulfillment_sku%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "barcodes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "barcode list"
                },
                "maxItems": 100,
                "description": "barcode list"
              },
              "hygroscopic": {
                "type": "boolean",
                "description": "true/false"
              },
              "precious": {
                "type": "boolean",
                "description": "true/false"
              },
              "product_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "food,liquid,danger,other"
              },
              "temperature_requirement": {
                "type": "string",
                "maxLength": 262144,
                "description": "1: normal temperature 4: refrigerated 6: frozen"
              },
              "pic_urls": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "at most 6 pictures url"
                },
                "maxItems": 100,
                "description": "at most 6 pictures url"
              },
              "serial_number_flag": {
                "type": "boolean",
                "description": "true/false"
              },
              "shelf_life_flag": {
                "type": "boolean",
                "description": "true/false"
              },
              "shelf_life_days": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "required if shelf_life_day is life_mgnt"
              },
              "reject_shelf_live": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "required if shelf_life_day is life_mgnt"
              },
              "alert_shelf_live": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "required if shelf_life_day is life_mgnt"
              },
              "offline_shelf_live": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "required if shelf_life_day is life_mgnt"
              },
              "sale_price": {
                "type": "string",
                "maxLength": 262144,
                "description": "sale price"
              },
              "fulfillment_sku_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "fulfillment_sku_id"
              }
            },
            "required": [
              "fulfillment_sku_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_message",
          "type": "String",
          "required": false
        },
        {
          "name": "data",
          "type": "Boolean",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /fbl/waybill/upload": {
      "id": 251604,
      "path": "/fbl/waybill/upload",
      "method": "POST",
      "risk": "H",
      "multipart": true,
      "description": "UploadWaybill: Use this API to upload a waybill pdf to Lazada site. The maximum size of an pdf file is 1MB. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Ffbl%2Fwaybill%2Fupload",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "waybill": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]*$"
                  },
                  "content_base64": {
                    "type": "string",
                    "minLength": 4,
                    "maxLength": 262144,
                    "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
                  }
                },
                "required": [
                  "name",
                  "content_base64"
                ],
                "additionalProperties": false,
                "description": "waybill pdf"
              },
              "package_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "package code"
              },
              "tracking_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "tracking number"
              },
              "extends_field": {
                "type": "string",
                "maxLength": 262144,
                "description": "extend fields"
              },
              "store_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "warehouse_code"
              }
            },
            "required": [
              "waybill",
              "package_code",
              "tracking_number",
              "store_code"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_message",
          "type": "String",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /im/message/list": {
      "id": 1265,
      "path": "/im/message/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetMessages: Get message list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fim%2Fmessage%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "session_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "session id"
              },
              "start_time": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "when request the first page pls input current timestamp，get the next page pls input previous page response field next_start_time"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size"
              },
              "last_message_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "previous page output param [last_message_id];it could be null when get the first page, get the next page pls input previous page response field last_message_id"
              }
            },
            "required": [
              "session_id",
              "start_time",
              "page_size"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "err_code",
          "type": "String",
          "required": true
        },
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "err_message",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "err_code"
          ],
          "name": "err_code",
          "neutral_values": []
        },
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /im/session/get": {
      "id": 251606,
      "path": "/im/session/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetSessionDetail: get session detail by sessionid Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fim%2Fsession%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "session_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "session id"
              }
            },
            "required": [
              "session_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "err_code",
          "type": "String",
          "required": true
        },
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "err_message",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "err_code"
          ],
          "name": "err_code",
          "neutral_values": []
        },
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /im/session/list": {
      "id": 1267,
      "path": "/im/session/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetSessionList: query seller session list Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fim%2Fsession%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "last_session_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "previous page output param [last_session_id];The last session id on this page, it needs to be passed in as an input parameter when pulling the next page"
              },
              "start_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "next page start time;when pull first page pls input current timestamp， when pull next page pls input last page response field next_start_time"
              },
              "page_size": {
                "type": "string",
                "maxLength": 262144,
                "description": "page size"
              }
            },
            "required": [
              "start_time",
              "page_size"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "err_message",
          "type": "String",
          "required": true
        },
        {
          "name": "err_code",
          "type": "String",
          "required": true
        },
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "err_code"
          ],
          "name": "err_code",
          "neutral_values": []
        }
      ]
    },
    "POST /im/message/recall": {
      "id": 1268,
      "path": "/im/message/recall",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "MessageRecall: message recall Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fim%2Fmessage%2Frecall",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "session_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "session id;conversation id"
              },
              "message_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "the id of message that need to be recalled;1）Cannot be recalled more than two minutes since the message has been sent 2）system message could not be recalled"
              }
            },
            "required": [
              "session_id",
              "message_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "err_code",
          "type": "String",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "err_message",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "err_code"
          ],
          "name": "err_code",
          "neutral_values": []
        },
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /im/session/open": {
      "id": 251607,
      "path": "/im/session/open",
      "method": "POST",
      "risk": "W",
      "multipart": false,
      "description": "OpenSession: open a new conversation Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fim%2Fsession%2Fopen",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "orderId"
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "session_id",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": []
    },
    "POST /im/session/read": {
      "id": 1269,
      "path": "/im/session/read",
      "method": "POST",
      "risk": "W",
      "multipart": false,
      "description": "ReadSession: session read Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fim%2Fsession%2Fread",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "session_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "session id;unique id of a conversation"
              },
              "last_read_message_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "last message id of user readed"
              }
            },
            "required": [
              "session_id",
              "last_read_message_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "err_code",
          "type": "String",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "err_message",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "err_code"
          ],
          "name": "err_code",
          "neutral_values": []
        },
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /im/message/send": {
      "id": 251608,
      "path": "/im/message/send",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "SendMessage: send message Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fim%2Fmessage%2Fsend",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "session_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "conversation id"
              },
              "template_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "message template id, 1: normal text message 3: picture message 4: emoji message 10006: item message 10007: order message 10008: voucher message 10010: invite buyers to follow the store 6: video message, use this API to upload video (The video duration is greater than 3s and less than 180s)"
              },
              "txt": {
                "type": "string",
                "maxLength": 262144,
                "description": "template_id=1 required"
              },
              "img_url": {
                "type": "string",
                "maxLength": 262144,
                "description": "template_id=3 required"
              },
              "width": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "template_id=3/6 required"
              },
              "height": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "template_id=3/6 required"
              },
              "item_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "template_id=10006 required"
              },
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "template_id=10007 required"
              },
              "promotion_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "template_id=10008 required"
              },
              "video_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "template_id=6 required"
              }
            },
            "required": [
              "session_id",
              "template_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "err_code",
          "type": "String",
          "required": true
        },
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "err_message",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "err_code"
          ],
          "name": "err_code",
          "neutral_values": []
        },
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /sponsor/solutions/adgroup/addAdgroupBatch": {
      "id": 251640,
      "path": "/sponsor/solutions/adgroup/addAdgroupBatch",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "addAdgroupBatch: Do add adgroup for one campaign. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fadgroup%2FaddAdgroupBatch",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "campaignId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Campaign id which you want to add into."
              },
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "adgroupViewDTOList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "adgroupName": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "The adgroup name, normanlly is the product name."
                    },
                    "autoItemSelect": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "The way the product be selected.1:manual(I want to select products manually from my store.);2:auto(Let Lazada optimize the products within the campaigns in real-time to maximize the campaigns' performance).This must be the same as the campaign."
                    },
                    "bidPrice": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Let Lazada automatically set cost-effective bid prices for your products."
                    },
                    "itemId": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Product id."
                    },
                    "autoCreative": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Let Lazada automatically set creatives for your products.1:ON;0:OFF.This must be the same as the campaign."
                    },
                    "autoKeyword": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Let Lazada automatically set keyword for your products.1:manual(I want to select keywords manually for my product selection.);2:auto(Let Lazada optimize the keywords relating to your products in real time to maximize the campaigns' performance).This must be the same as the campaign."
                    },
                    "bidwordViewDTOList": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "keyword": {
                            "type": "string",
                            "maxLength": 262144,
                            "description": "The specific keyword.eg:shoe."
                          },
                          "bidPrice": {
                            "type": "string",
                            "maxLength": 262144,
                            "description": "Let Lazada automatically set cost-effective bid prices for your products."
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "Bid word list"
                      },
                      "maxItems": 100,
                      "description": "Bid word list"
                    },
                    "audienceViewDTOList": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "adCrowdTag": {
                            "type": "number",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "1:on store visitors in the past 15 days;2:on in-market audiences for similar products;3:Store Awareness Audience;4:Store Interest Audience"
                          },
                          "discount": {
                            "type": "number",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "The discount you want to give.eg:10 means 10% discount."
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "This setting allows you to bid higher on premium audiences that are more likely to convert in your store."
                      },
                      "maxItems": 100,
                      "description": "This setting allows you to bid higher on premium audiences that are more likely to convert in your store."
                    }
                  },
                  "required": [
                    "adgroupName",
                    "autoItemSelect",
                    "bidPrice",
                    "itemId",
                    "autoCreative",
                    "autoKeyword"
                  ],
                  "additionalProperties": false,
                  "description": "Adgroup list"
                },
                "maxItems": 100,
                "description": "Adgroup list"
              }
            },
            "required": [
              "campaignId",
              "bizCode",
              "adgroupViewDTOList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /sponsor/solutions/addSolution": {
      "id": 251641,
      "path": "/sponsor/solutions/addSolution",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "addSolution: Add sponsor solution Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2FaddSolution",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "autoKeyword": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Let Lazada automatically set keyword for your products.1:manual(I want to select keywords manually for my product selection.);2:auto(Let Lazada optimize the keywords relating to your products in real time to maximize the campaigns' performance)."
              },
              "endDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign end date."
              },
              "platform": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Placements determine where shoppers will see your promoted products.3:Search Result Page;4:Just For You Page"
                },
                "maxItems": 100,
                "description": "Placements determine where shoppers will see your promoted products.3:Search Result Page;4:Just For You Page"
              },
              "autoCreative": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Lazada automatically set creatives for your products.1:ON;0:OFF."
              },
              "campaignObjective": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Your campaign objective helps determine your bidding strategy - Traffic objective helps you to increase the number of clicks to your store, while sales objective helps to increase your store’s sales.1:Traffic;2:Sales."
              },
              "campaignType": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Unlock different ways to bids, select products, and keywords with campaign types.1:Standard;2:Smart."
              },
              "campaignModel": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Fine granularity to distinguish solutions."
              },
              "maxBid": {
                "type": "string",
                "maxLength": 262144,
                "description": "Max bid determines the highest amount that you're willing to pay for a click on your promoted product.String type, -1 means no limit."
              },
              "autoItemSelect": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The way the product be selected.1:manual(I want to select products manually from my store.);2:auto(Let Lazada optimize the products within the campaigns in real-time to maximize the campaigns' performance)"
              },
              "dayBudget": {
                "type": "string",
                "maxLength": 262144,
                "description": "Budget indicates the maximum amount you’re willing to pay each day."
              },
              "campaignName": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign name."
              },
              "startDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign start date."
              },
              "adgroupViewDTOlistWithFeed": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "adgroupName": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Adgroup name, normally is product name,"
                    },
                    "bidPrice": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "This is the maximum bid price that you have set for your campaign.When campaignType is 1, this field must be filled."
                    },
                    "autoKeyword": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Let Lazada automatically set keyword for your products.1:manual(I want to select keywords manually for my product selection.);2:auto(Let Lazada optimize the keywords relating to your products in real time to maximize the campaigns' performance). This must be the same as the campaign."
                    },
                    "audienceViewDTOList": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "adCrowdTag": {
                            "type": "number",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "1:on store visitors in the past 15 days;2:on in-market audiences for similar products;3:Store Awareness Audience;4:Store Interest Audience"
                          },
                          "discount": {
                            "type": "number",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "The discount you want to give.eg:10 means 10% discount."
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "This setting allows you to bid higher on premium audiences that are more likely to convert in your store."
                      },
                      "maxItems": 100,
                      "description": "This setting allows you to bid higher on premium audiences that are more likely to convert in your store."
                    },
                    "itemId": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Product id."
                    },
                    "bidwordViewDTOList": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "keyword": {
                            "type": "string",
                            "maxLength": 262144,
                            "description": "The specific keyword.eg:shoe."
                          },
                          "bidPrice": {
                            "type": "string",
                            "maxLength": 262144,
                            "description": "This is the maximum bid price that you have set for your campaign."
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "Bid word list"
                      },
                      "maxItems": 100,
                      "description": "Bid word list"
                    },
                    "autoItemSelect": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "The way the product be selected.1:manual(I want to select products manually from my store.);2:auto(Let Lazada optimize the products within the campaigns in real-time to maximize the campaigns' performance)"
                    },
                    "autoCreative": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Let Lazada automatically set creatives for your products.1:ON;0:OFF. This must be the same as the campaign."
                    }
                  },
                  "required": [
                    "adgroupName",
                    "autoKeyword",
                    "itemId",
                    "autoItemSelect",
                    "autoCreative"
                  ],
                  "additionalProperties": false,
                  "description": "Adgroup list."
                },
                "maxItems": 100,
                "description": "Adgroup list."
              }
            },
            "required": [
              "bizCode",
              "endDate",
              "platform",
              "autoCreative",
              "campaignObjective",
              "campaignType",
              "campaignModel",
              "maxBid",
              "autoItemSelect",
              "dayBudget",
              "campaignName",
              "startDate",
              "adgroupViewDTOlistWithFeed"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "result",
          "type": "Object",
          "required": false
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /sponsor/solutions/adgroup/deleteAdgroupBatch": {
      "id": 251643,
      "path": "/sponsor/solutions/adgroup/deleteAdgroupBatch",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "deleteAdgroupBatch: Delete adgroup batch. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fadgroup%2FdeleteAdgroupBatch",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "adgroupIdList": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Adgroup id list."
                },
                "maxItems": 100,
                "description": "Adgroup id list."
              }
            },
            "required": [
              "bizCode",
              "adgroupIdList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /sponsor/solutions/campaign/deleteCampaign": {
      "id": 251644,
      "path": "/sponsor/solutions/campaign/deleteCampaign",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "deleteCampaign: Delete campaign. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fcampaign%2FdeleteCampaign",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "campaignIdList": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Campaign id list."
                },
                "maxItems": 100,
                "description": "Campaign id list."
              },
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              }
            },
            "required": [
              "campaignIdList",
              "bizCode"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Number",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/account/getAccountSignInfo": {
      "id": 251645,
      "path": "/sponsor/solutions/account/getAccountSignInfo",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getAccountSignInfo: Get seller account sign status. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Faccount%2FgetAccountSignInfo",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/wallet/getAutoTopUpOptionOneConfig": {
      "id": 251646,
      "path": "/sponsor/solutions/wallet/getAutoTopUpOptionOneConfig",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getAutoTopUpOptionOneConfig: Get auto top up option one config. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fwallet%2FgetAutoTopUpOptionOneConfig",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/campaign/getCampaign": {
      "id": 251647,
      "path": "/sponsor/solutions/campaign/getCampaign",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getCampaign: Get campaign list with bizCode by seller. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fcampaign%2FgetCampaign",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Discovery:sponsoredSearch"
              },
              "campaignId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "123"
              }
            },
            "required": [
              "bizCode",
              "campaignId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "String",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/campaign/getCampaignCount": {
      "id": 251648,
      "path": "/sponsor/solutions/campaign/getCampaignCount",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getCampaignCount: Get campaign count with bizCode for each solution type. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fcampaign%2FgetCampaignCount",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              }
            },
            "required": [
              "bizCode"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Number",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/report/getDiscoveryReportAdgroup": {
      "id": 251649,
      "path": "/sponsor/solutions/report/getDiscoveryReportAdgroup",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getDiscoveryReportAdgroup: Get sponsored discovery report adgroup level Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Freport%2FgetDiscoveryReportAdgroup",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "campaignType": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign Type,1 standard 2 automated"
              },
              "campaignName": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign Name, frazzy search"
              },
              "campaignId": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign Id"
              },
              "adgroupName": {
                "type": "string",
                "maxLength": 262144,
                "description": "Adgroup Name"
              },
              "adgroupId": {
                "type": "string",
                "maxLength": 262144,
                "description": "Adgroup Id"
              },
              "itemId": {
                "type": "string",
                "maxLength": 262144,
                "description": "Item Id"
              },
              "useRtTable": {
                "type": "boolean",
                "description": "It means that if endDate have selected today, and you need realtime data,then set useRtTable=true If useRtTable=false,it will not search realtime data"
              },
              "sort": {
                "type": "string",
                "maxLength": 262144,
                "description": "sort column,we have provide some index to sort"
              },
              "pageNo": {
                "type": "string",
                "maxLength": 262144,
                "description": "Page No，default 1,max=100"
              },
              "pageSize": {
                "type": "string",
                "maxLength": 262144,
                "description": "Page No, default 10, max=100"
              },
              "order": {
                "type": "string",
                "maxLength": 262144,
                "description": "ASC or DESC, other String is invalid"
              },
              "startDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "start date, format like yyyy-MM-dd"
              },
              "endDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "end date , date, format like yyyy-MM-dd"
              }
            },
            "required": [
              "pageNo",
              "pageSize",
              "startDate",
              "endDate"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/report/getDiscoveryReportAudience": {
      "id": 251650,
      "path": "/sponsor/solutions/report/getDiscoveryReportAudience",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getDiscoveryReportAudience: Get sponsored discovery report audience level Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Freport%2FgetDiscoveryReportAudience",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "campaignName": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign Name"
              },
              "campaignId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Campaign Id"
              },
              "audienceGroup": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Audienct type 1:15 days Visitors 2:Similar Product Visitors 3:Store Awareness Audience 4:Store Interest Audience 5:DMP Crow Audience 6:Gender 7:Age"
              },
              "sort": {
                "type": "string",
                "maxLength": 262144,
                "description": "sort column,we have provide some index to sort"
              },
              "order": {
                "type": "string",
                "maxLength": 262144,
                "description": "ASC or DESC, other String is invalid"
              },
              "pageNo": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page No，default 1,max=100"
              },
              "pageSize": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page No, default 10, max=100"
              },
              "startDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "start date, format like yyyy-MM-dd"
              },
              "endDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "end date , date, format like yyyy-MM-dd"
              }
            },
            "required": [
              "pageNo",
              "pageSize",
              "startDate",
              "endDate"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/report/getDiscoveryReportCampaign": {
      "id": 251651,
      "path": "/sponsor/solutions/report/getDiscoveryReportCampaign",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getDiscoveryReportCampaign: Get sponsored discovery report campaign level Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Freport%2FgetDiscoveryReportCampaign",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "campaignId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Campaign Id"
              },
              "useRtTable": {
                "type": "boolean",
                "description": "It means that if endDate have selected today, and you need realtime data,then set useRtTable=true If useRtTable=false,it will not search realtime data"
              },
              "sort": {
                "type": "string",
                "maxLength": 262144,
                "description": "sort column,we have provide some index to sort"
              },
              "order": {
                "type": "string",
                "maxLength": 262144,
                "description": "ASC or DESC, other String is invalid"
              },
              "startDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "start date, format like yyyy-MM-dd"
              },
              "endDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "end date , date, format like yyyy-MM-dd"
              },
              "pageNo": {
                "type": "string",
                "maxLength": 262144,
                "description": "Page No，default 1,max=100"
              },
              "pageSize": {
                "type": "string",
                "maxLength": 262144,
                "description": "Page No, default 10, max=100"
              },
              "campaignType": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Campaign type, 1 Manual 2 Automated"
              },
              "productType": {
                "type": "string",
                "maxLength": 262144,
                "description": "Placement , N Sponsored Search, J Sponsored Product"
              },
              "campaignName": {
                "type": "string",
                "maxLength": 262144,
                "description": "campaign name，fuzzy search"
              }
            },
            "required": [
              "startDate",
              "endDate",
              "pageNo",
              "pageSize"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/report/getDiscoveryReportKeyword": {
      "id": 251652,
      "path": "/sponsor/solutions/report/getDiscoveryReportKeyword",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getDiscoveryReportKeyword: Get sponsored discovery report keyword level Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Freport%2FgetDiscoveryReportKeyword",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "adgroupName": {
                "type": "string",
                "maxLength": 262144,
                "description": "Adgroup Name"
              },
              "adgroupId": {
                "type": "string",
                "maxLength": 262144,
                "description": "Adgroup Id"
              },
              "keyword": {
                "type": "string",
                "maxLength": 262144,
                "description": "Keyword"
              },
              "useRtTable": {
                "type": "boolean",
                "description": "It means that if endDate have selected today, and you need realtime data,then set useRtTable=true If useRtTable=false,it will not search realtime data"
              },
              "sort": {
                "type": "string",
                "maxLength": 262144,
                "description": "sort column,we have provide some index to sort"
              },
              "order": {
                "type": "string",
                "maxLength": 262144,
                "description": "ASC or DESC, other String is invalid"
              },
              "pageNo": {
                "type": "string",
                "maxLength": 262144,
                "description": "Page No，default 1,max=100"
              },
              "pageSize": {
                "type": "string",
                "maxLength": 262144,
                "description": "Page No, default 10, max=100"
              },
              "startDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "start date, format like yyyy-MM-dd"
              },
              "endDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "end date , date, format like yyyy-MM-dd"
              },
              "campaignName": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign Name"
              },
              "campaignId": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign Id"
              }
            },
            "required": [
              "pageNo",
              "pageSize",
              "startDate",
              "endDate"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/account/getLatestSignInfo": {
      "id": 1785,
      "path": "/sponsor/solutions/account/getLatestSignInfo",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getLatestSignInfo: Get the latest url of sign(T&C). Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Faccount%2FgetLatestSignInfo",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/report/getReportCampaignOnPrePlacement": {
      "id": 251653,
      "path": "/sponsor/solutions/report/getReportCampaignOnPrePlacement",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getReportCampaignOnFIrstSlot: Get sponsored discovery report campaign first slot Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Freport%2FgetReportCampaignOnPrePlacement",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "sort": {
                "type": "string",
                "maxLength": 262144,
                "description": "sort column,we have provide some index to sort"
              },
              "order": {
                "type": "string",
                "maxLength": 262144,
                "description": "ASC or DESC, other String is invalid"
              },
              "pageNo": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page No，default 1,max=100"
              },
              "pageSize": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page Size, default 10, max=100"
              },
              "startDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "start date, format like yyyy-MM-dd"
              },
              "endDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "end date , date, format like yyyy-MM-dd"
              },
              "campaignName": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign Name"
              },
              "campaignId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "campagnId"
              },
              "productType": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product Type, N:Sponsored Search(All) F:Firsh Search Slot"
              },
              "useRtTable": {
                "type": "boolean",
                "description": "It means that if endDate have selected today, and you need realtime data,then set useRtTable=true If useRtTable=false,it will not search realtime data"
              }
            },
            "required": [
              "pageNo",
              "pageSize",
              "startDate",
              "endDate"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/report/getReportOverview": {
      "id": 251654,
      "path": "/sponsor/solutions/report/getReportOverview",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getReportOverview: Get report overview. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Freport%2FgetReportOverview",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "lastStartDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "-"
              },
              "endDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "-"
              },
              "useRtTable": {
                "type": "boolean",
                "description": "-"
              },
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "-"
              },
              "lastEndDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "-"
              },
              "startDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "-"
              }
            },
            "required": [
              "lastStartDate",
              "endDate",
              "useRtTable",
              "bizCode",
              "lastEndDate",
              "startDate"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "String",
          "required": true
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/report/getReportOverviewMetric": {
      "id": 251655,
      "path": "/sponsor/solutions/report/getReportOverviewMetric",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getReportOverviewMetric: get report overview metric Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Freport%2FgetReportOverviewMetric",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "metricType": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The type pf metric.1:spend;2:impressions;3:clicks;4:ctr;5:units sold;6:revenue;7:cpc;8:roi;9:store order;10:store a2c;11:product order."
              },
              "endDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "End date."
              },
              "useRtTable": {
                "type": "boolean",
                "description": "If you need to search data for today, then use true, otherwise false."
              },
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "startDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "Start date."
              }
            },
            "required": [
              "metricType",
              "endDate",
              "useRtTable",
              "bizCode",
              "startDate"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "String",
          "required": true
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/category/listCategory": {
      "id": 251656,
      "path": "/sponsor/solutions/category/listCategory",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "listCategory: list category Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fcategory%2FlistCategory",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "parentId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The category parent id."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object[]",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/keyword/listKeywordByAdgroup": {
      "id": 251657,
      "path": "/sponsor/solutions/keyword/listKeywordByAdgroup",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "listKeywordByAdgroup: List keyword by adgroup. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fkeyword%2FlistKeywordByAdgroup",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "campaignObjective": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Your campaign objective helps determine your bidding strategy - Traffic objective helps you to increase the number of clicks to your store, while sales objective helps to increase your store’s sales.1:Traffic;2:Sales."
              },
              "campaignType": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Unlock different ways to bids, select products, and keywords with campaign types."
              },
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "itemId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Product id."
              },
              "adgroupId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Adgroup id."
              }
            },
            "required": [
              "campaignObjective",
              "campaignType",
              "bizCode",
              "itemId",
              "adgroupId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object[]",
          "required": true
        },
        {
          "name": "success",
          "type": "String",
          "required": true
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": true
        },
        {
          "name": "totalCount",
          "type": "Number",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/keyword/listKeywordByItem": {
      "id": 251658,
      "path": "/sponsor/solutions/keyword/listKeywordByItem",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "listKeywordByItem: List keyword by item. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fkeyword%2FlistKeywordByItem",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "campaignObjective": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Your campaign objective helps determine your bidding strategy - Traffic objective helps you to increase the number of clicks to your store, while sales objective helps to increase your store’s sales.1:Traffic;2:Sales."
              },
              "campaignType": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Unlock different ways to bids, select products, and keywords with campaign types."
              },
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "itemId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Product id."
              }
            },
            "required": [
              "campaignObjective",
              "campaignType",
              "bizCode",
              "itemId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object[]",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/adgroup/searchAdgroupList": {
      "id": 251660,
      "path": "/sponsor/solutions/adgroup/searchAdgroupList",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "searchAdgroupList: Search adgroup with bizCode by seller. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fadgroup%2FsearchAdgroupList",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "pageSize": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page size."
              },
              "endDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign end date."
              },
              "campaignId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Campaign id."
              },
              "pageNo": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number."
              },
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "adgroupName": {
                "type": "string",
                "maxLength": 262144,
                "description": "Adgroup name for fuzzy search."
              },
              "startDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign start date."
              },
              "onlineStatus": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The campaign online status.1:Online;0:Offline;9:deleted."
              }
            },
            "required": [
              "pageSize",
              "endDate",
              "campaignId",
              "pageNo",
              "bizCode",
              "startDate"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": true
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": true
        },
        {
          "name": "totalCount",
          "type": "Number",
          "required": false
        },
        {
          "name": "result",
          "type": "Object[]",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/campaign/searchCampaignList": {
      "id": 251661,
      "path": "/sponsor/solutions/campaign/searchCampaignList",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "searchCampaignList: Search campaign list with bizCode for sellers. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fcampaign%2FsearchCampaignList",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "onlineStatus": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The campaign online status.1:Online;0:Offline;9:deleted."
              },
              "startDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign start date."
              },
              "endDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign end date."
              },
              "pageNo": {
                "type": "string",
                "maxLength": 262144,
                "description": "Page number."
              },
              "pageSize": {
                "type": "string",
                "maxLength": 262144,
                "description": "Page size."
              }
            },
            "required": [
              "bizCode",
              "startDate",
              "endDate",
              "pageNo",
              "pageSize"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "totalCount",
          "type": "Number",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        },
        {
          "name": "result",
          "type": "Object[]",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/keyword/searchKeyword": {
      "id": 251662,
      "path": "/sponsor/solutions/keyword/searchKeyword",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "searchKeyword: Search keyword with specific word. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fkeyword%2FsearchKeyword",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "campaignObjective": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Your campaign objective helps determine your bidding strategy - Traffic objective helps you to increase the number of clicks to your store, while sales objective helps to increase your store’s sales.1:Traffic;2:Sales."
              },
              "campaignType": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Unlock different ways to bids, select products, and keywords with campaign types."
              },
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "itemQuery": {
                "type": "string",
                "maxLength": 262144,
                "description": "The word you do not want to put in the result."
              },
              "itemId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Product id."
              },
              "searchWord": {
                "type": "string",
                "maxLength": 262144,
                "description": "The specific word."
              }
            },
            "required": [
              "campaignObjective",
              "campaignType",
              "bizCode",
              "itemQuery",
              "itemId",
              "searchWord"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object[]",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": true
        },
        {
          "name": "totalCount",
          "type": "Number",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "GET /sponsor/solutions/product/searchProductWithPage": {
      "id": 251663,
      "path": "/sponsor/solutions/product/searchProductWithPage",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "searchProductWithPage: Search product. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fproduct%2FsearchProductWithPage",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "brandName": {
                "type": "string",
                "maxLength": 262144,
                "description": "Prodct brand name."
              },
              "campaignType": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Unlock different ways to bids, select products, and keywords with campaign types."
              },
              "pageSize": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page size."
              },
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "placementList": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Placements determine where shoppers will see your promoted products.3:Search Result Page;4:Just For You Page"
                },
                "maxItems": 100,
                "description": "Placements determine where shoppers will see your promoted products.3:Search Result Page;4:Just For You Page"
              },
              "productName": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product name to fuzzy search."
              },
              "campaignObjectLive": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Your campaign objective helps determine your bidding strategy - Traffic objective helps you to increase the number of clicks to your store, while sales objective helps to increase your store’s sales.1:Traffic;2:Sales."
              },
              "eligible": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Only search product which is eligible|ineligible.1:eligible;0:ineligible."
              },
              "pageNo": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number."
              },
              "sellerSku": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product sellerSku."
              },
              "maxCpc": {
                "type": "string",
                "maxLength": 262144,
                "description": "Max bid determines the highest amount that you're willing to pay for a click on your promoted product.-1 means no limit."
              },
              "categoryId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Input category id to exact search."
              },
              "itemIdBlackList": {
                "type": "array",
                "items": {
                  "type": "number",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Input item id which you do not want put into result."
                },
                "maxItems": 100,
                "description": "Input item id which you do not want put into result."
              }
            },
            "required": [
              "campaignType",
              "pageSize",
              "bizCode",
              "placementList",
              "campaignObjectLive",
              "eligible",
              "pageNo",
              "maxCpc"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object[]",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": true
        },
        {
          "name": "totalCount",
          "type": "Number",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /sponsor/solutions/adgroup/updateAdgroupBatch": {
      "id": 251664,
      "path": "/sponsor/solutions/adgroup/updateAdgroupBatch",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "updateAdgroupBatch: Update adgroup batch. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fadgroup%2FupdateAdgroupBatch",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "adgroupViewDTOList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "adgroupId": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Adgroup id."
                    },
                    "switchStatus": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "Is the adgroup online rightnow.1:ON:0:OFF."
                    }
                  },
                  "required": [
                    "adgroupId",
                    "switchStatus"
                  ],
                  "additionalProperties": false,
                  "description": "Adgroup list"
                },
                "maxItems": 100,
                "description": "Adgroup list"
              }
            },
            "required": [
              "bizCode",
              "adgroupViewDTOList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /sponsor/solutions/campaign/updateCampaign": {
      "id": 1777,
      "path": "/sponsor/solutions/campaign/updateCampaign",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "updateCampaign: Update campaign with status field. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fsponsor%2Fsolutions%2Fcampaign%2FupdateCampaign",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "campaignId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Campaign id."
              },
              "campaignName": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign name."
              },
              "startDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign start date."
              },
              "endDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "Campaign end date."
              },
              "dayBudget": {
                "type": "string",
                "maxLength": 262144,
                "description": "Budget indicates the maximum amount you’re willing to pay each day."
              },
              "bizCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "Decided to choose which advertisement solution.SD:sponsoredSearch."
              },
              "switchStatus": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Campaign swtich status.1:Online;0:Offline."
              }
            },
            "required": [
              "campaignId",
              "bizCode"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "errorMsg",
          "type": "String",
          "required": false
        },
        {
          "name": "analyseTraceId",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        }
      ]
    },
    "POST /jit/purchase_order/batch_pickup_deliver": {
      "id": 251667,
      "path": "/jit/purchase_order/batch_pickup_deliver",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "BatchDeliverJitPurchaseOrder: Batch Pickup Deliver Jit Purchase Order. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fjit%2Fpurchase_order%2Fbatch_pickup_deliver",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "purchaseOrderNoList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "采购单号列表，最大100个。{[\"POJ1001\",\"POJ1002\"]}"
                },
                "maxItems": 100,
                "description": "采购单号列表，最大100个。{[\"POJ1001\",\"POJ1002\"]}"
              },
              "shipperAreaCode": {
                "type": "string",
                "maxLength": 262144,
                "description": "揽收联系人地址区域，如：CN： 当前支持CN，VN，TH，PH，ID，MY一共6个地区。必填。"
              },
              "shipperAddressId": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "揽收联系人地址id。必填。"
              },
              "shipperAddressDetail": {
                "type": "string",
                "maxLength": 262144,
                "description": "揽收详细地址。必填。"
              },
              "shipperMobilePhone": {
                "type": "string",
                "maxLength": 262144,
                "description": "揽收联系人电话。必填。"
              },
              "shipperName": {
                "type": "string",
                "maxLength": 262144,
                "description": "揽收联系人姓名。必填。"
              },
              "estimatedPickupDate": {
                "type": "string",
                "maxLength": 262144,
                "description": "预约揽收日期 {yyyy-MM-dd}。非必填"
              }
            },
            "required": [
              "purchaseOrderNoList",
              "shipperAreaCode",
              "shipperAddressId",
              "shipperAddressDetail",
              "shipperMobilePhone",
              "shipperName"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "POST /choice/stock/edit": {
      "id": 251668,
      "path": "/choice/stock/edit",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "EditChoiceSkuStock: batch update choice jit product stock by skuId Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fchoice%2Fstock%2Fedit",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "item_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "item id"
              },
              "site": {
                "type": "string",
                "maxLength": 262144,
                "description": "The country site of the queried Product"
              },
              "sku_edit_stock": {
                "type": "string",
                "maxLength": 262144,
                "description": "Key：sku_id Value: sellable stock"
              }
            },
            "required": [
              "item_id",
              "site",
              "sku_edit_stock"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": false
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /choice/product/item/get": {
      "id": 251669,
      "path": "/choice/product/item/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetChoiceProductItem: Get single product by ItemId or SellerSku. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fchoice%2Fproduct%2Fitem%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "item_id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Call this API; Either \"Item Id\" or \"Seller Sku\" must be selected as the request parameter"
              },
              "seller_sku": {
                "type": "string",
                "maxLength": 262144,
                "description": "Call this API; Either \"Item Id\" or \"Seller Sku\" must be selected as the request parameter"
              },
              "site": {
                "type": "string",
                "maxLength": 262144,
                "description": "The country site of the queried Product"
              }
            },
            "required": [
              "site"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "GET /choice/products/get": {
      "id": 251670,
      "path": "/choice/products/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetChoiceProducts: Use this API to get detailed information of the specified products. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fchoice%2Fproducts%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "filter": {
                "type": "string",
                "maxLength": 262144,
                "description": "Returns the products with the status matching this parameter. Possible values are all, live, inactive, deleted, pending, rejected, sold-out. Mandatory."
              },
              "update_before": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned product list to those updated before or on a specified date, given in ISO 8601 date format. Optional"
              },
              "create_before": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned products to those created before or on the specified date, given in ISO 8601 date format. Optional"
              },
              "offset": {
                "type": "string",
                "maxLength": 262144,
                "description": "Deprecated(The number of Items you want to skip before you start counting),It is recommended to use date for scrolling query.The maximum offset is 10000"
              },
              "create_after": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned products to those created after or on the specified date, given in ISO 8601 date format. Optional"
              },
              "update_after": {
                "type": "string",
                "maxLength": 262144,
                "description": "Limits the returned products to those updated after or on the specified date, given in ISO 8601 date format. Optional"
              },
              "limit": {
                "type": "string",
                "maxLength": 262144,
                "description": "The number of Items you would like to fetch from every response,The maximum is 50."
              },
              "options": {
                "type": "string",
                "maxLength": 262144,
                "description": "This value can be used to get more stock information. e.g., Options=1 means contain ReservedStock, RtsStock, PendingStock, RealTimeStock, FulfillmentBySellable."
              },
              "sku_seller_list": {
                "type": "string",
                "maxLength": 262144,
                "description": "Only products that have the Seller SKU in this list will be returned. Input should be a JSON array. For example, [\"Apple 6S Gold\", \"Apple 6S Black\"]. It only matches the whole words. A maximum of 100 SKUs can be returned."
              },
              "site": {
                "type": "string",
                "maxLength": 262144,
                "description": "The country site of the queried Product"
              }
            },
            "required": [
              "site"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /choice/seller/get": {
      "id": 251671,
      "path": "/choice/seller/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetChoiceSeller: Get choice seller information by seller ID and site Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fchoice%2Fseller%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "site": {
                "type": "string",
                "maxLength": 262144,
                "description": "The country site of the queried merchant"
              }
            },
            "required": [
              "site"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": false
        }
      ],
      "outcomes": []
    },
    "GET /choice/sku_item_relation/get_by_sku": {
      "id": 251672,
      "path": "/choice/sku_item_relation/get_by_sku",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "GetChoiceSkuItemRelationBySku: get the relation between platformSku and item by sku Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fchoice%2Fsku_item_relation%2Fget_by_sku",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "item_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "itemId"
              },
              "sku_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "skuId"
              },
              "site": {
                "type": "string",
                "maxLength": 262144,
                "description": "The country site of the queried Product item"
              }
            },
            "required": [
              "item_id",
              "sku_id",
              "site"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": []
    },
    "POST /jit/purchase_order/package": {
      "id": 2014,
      "path": "/jit/purchase_order/package",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "PackageJitPurchaseOrder: Package Jit Purchase Order. Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fjit%2Fpurchase_order%2Fpackage",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "purchase_order_no_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "采购单列表，最大100个。{[\"POJ1001\",\"POJ1002\"]}"
                },
                "maxItems": 100,
                "description": "采购单列表，最大100个。{[\"POJ1001\",\"POJ1002\"]}"
              }
            },
            "required": [
              "purchase_order_no_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /jit/purchase_order/print": {
      "id": 2013,
      "path": "/jit/purchase_order/print",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "PrintJitPurchaseOrderAndItem: Print Jit Purchase Order And Item. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fjit%2Fpurchase_order%2Fprint",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "purchase_order_no_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "采购单号列表，最大20个。{[\"POJ1001\",\"POJ1002\"]}"
                },
                "maxItems": 100,
                "description": "采购单号列表，最大20个。{[\"POJ1001\",\"POJ1002\"]}"
              },
              "print_order": {
                "type": "boolean",
                "description": "是否打印PO单。{true/false}"
              },
              "print_barcode": {
                "type": "string",
                "maxLength": 262144,
                "description": "是否打印货品barcode。{true/false}"
              },
              "pdf_size": {
                "type": "string",
                "maxLength": 262144,
                "description": "pdf样式。{A4/6030/100150}"
              }
            },
            "required": [
              "purchase_order_no_list",
              "print_order",
              "print_barcode",
              "pdf_size"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /pickup_order/print": {
      "id": 2018,
      "path": "/pickup_order/print",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "PrintPickuoOrder: Print Pickuo Order. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpickup_order%2Fprint",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "pickup_order_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "揽收单号"
              },
              "pdf_size": {
                "type": "string",
                "maxLength": 262144,
                "description": "pdf格式枚举类型。A4纸大小样式、100*100大小样式。{PICKUP_A4/PICKUP_1010}"
              },
              "box_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "装箱数量。（最大值 100）"
              }
            },
            "required": [
              "pickup_order_no",
              "pdf_size",
              "box_number"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /jit/purchase_order/query_list": {
      "id": 2010,
      "path": "/jit/purchase_order/query_list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "QueryListJitPurchaseOrder: Query List Jit Purchase Order. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fjit%2Fpurchase_order%2Fquery_list",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "gmt_create_begin": {
                "type": "string",
                "maxLength": 262144,
                "description": "单据创建开始时间，建单时间范围(即end-begin)需要在90天内。{yyyy-MM-dd HH:mm:ss}"
              },
              "gmt_create_end": {
                "type": "string",
                "maxLength": 262144,
                "description": "单据创建结束时间，建单时间范围(即end-begin)需要在90天内。{yyyy-MM-dd HH:mm:ss}"
              },
              "purchase_order_no_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "采购单列表，最大20个。{[\"POJ1001\",\"POJ1002\"]}"
                },
                "maxItems": 100,
                "description": "采购单列表，最大20个。{[\"POJ1001\",\"POJ1002\"]}"
              },
              "logistics_no_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "description": "物流单列表，最大10个。{[\"LBX1001\",\"LBX1002\"]}"
                },
                "maxItems": 100,
                "description": "物流单列表，最大10个。{[\"LBX1001\",\"LBX1002\"]}"
              },
              "order_status": {
                "type": "string",
                "maxLength": 262144,
                "description": "单据状态 10:待打包; 20:待发货; 22:待收货; 25:已到仓; 40:已完成; -100610:超时关闭; -100:买家取消；不传则返回所有状态的采购单；"
              },
              "page_index": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "当前页，默认1。"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "分页大小，最大50个，默认20。"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /jit/purchase_order/query_list_purchase_item": {
      "id": 2012,
      "path": "/jit/purchase_order/query_list_purchase_item",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "QueryListPurchaseItem: Query List Purchase Item. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fjit%2Fpurchase_order%2Fquery_list_purchase_item",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "purchase_order_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "JIT采购单号"
              },
              "page_index": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "当前页，默认1。"
              },
              "page_size": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "分页大小，最大200个，默认20。"
              }
            },
            "required": [
              "purchase_order_no"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /pickup_order/query": {
      "id": 2011,
      "path": "/pickup_order/query",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "QueryPickupOrder: Query Pickup Order. Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpickup_order%2Fquery",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "pickup_order_no": {
                "type": "string",
                "maxLength": 262144,
                "description": "揽收单号"
              }
            },
            "required": [
              "pickup_order_no"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "result",
          "type": "Object",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "result",
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "result",
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/storeflashsale/activate": {
      "id": 141271,
      "path": "/promotion/storeflashsale/activate",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "ActivateStoreFlashSale: activate Store Flash Sale Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fstoreflashsale%2Factivate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotion id"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/storeflashsale/create": {
      "id": 141287,
      "path": "/promotion/storeflashsale/create",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "CreateStoreFlashSale: create a new Store Flash Sale Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fstoreflashsale%2Fcreate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "sku_model_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "sku_quantity": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "sku quantity that enjoys the promotion"
                    },
                    "item_id": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "product id"
                    },
                    "price": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "sku promotion price，local currency of the country, in standard monetary units."
                    },
                    "sku_id": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "sku_id"
                    }
                  },
                  "required": [
                    "sku_quantity",
                    "item_id",
                    "price",
                    "sku_id"
                  ],
                  "additionalProperties": false,
                  "description": "list of discount details by sku"
                },
                "maxItems": 100,
                "description": "list of discount details by sku"
              },
              "period_start_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "promotion start time"
              },
              "period_end_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "promotion start time"
              }
            },
            "required": [
              "sku_model_list",
              "period_start_time",
              "period_end_time"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Number",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "Number",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/storeflashsale/deactivate": {
      "id": 141283,
      "path": "/promotion/storeflashsale/deactivate",
      "method": "POST",
      "risk": "D",
      "multipart": false,
      "description": "DeactivateStoreFlashSale: deactivate Store Flash Sale Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fstoreflashsale%2Fdeactivate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "id"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "GET /promotion/storeflashsale/get": {
      "id": 141282,
      "path": "/promotion/storeflashsale/get",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "getStoreFlashSale: getStoreFlashSale Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fstoreflashsale%2Fget",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "promotionid"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": false
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": false
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": []
        }
      ]
    },
    "GET /promotion/storeflashsale/list": {
      "id": 141300,
      "path": "/promotion/storeflashsale/list",
      "method": "GET",
      "risk": "R",
      "multipart": false,
      "description": "ListStoreFlashSale: list Store Flash Sale Read one explicit page; fulfillment/order data may include authorized customer contacts. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fstoreflashsale%2Flist",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "cur_page": {
                "type": "string",
                "maxLength": 262144,
                "description": "cur page"
              },
              "page_size": {
                "type": "string",
                "maxLength": 262144,
                "description": "page size"
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "NOT_START | ONGOING | SUSPEND | FINISH"
              }
            },
            "required": [
              "cur_page",
              "page_size"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "data",
          "type": "Object",
          "required": true
        },
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    },
    "POST /promotion/storeflashsale/update": {
      "id": 141274,
      "path": "/promotion/storeflashsale/update",
      "method": "POST",
      "risk": "H",
      "multipart": false,
      "description": "UpdateStoreFlashSale: update storeflashsale Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write. Reference: https://open.lazada.com/apps/doc/api?path=%2Fpromotion%2Fstoreflashsale%2Fupdate",
      "input_schema": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "object",
            "properties": {
              "sku_model_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "sku_quantity": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "sku quantity that enjoys the promotion"
                    },
                    "item_id": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "product id"
                    },
                    "price": {
                      "type": "string",
                      "maxLength": 262144,
                      "description": "sku promotion price，local currency of the country, in standard monetary units."
                    },
                    "sku_id": {
                      "type": "number",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "sku_id"
                    }
                  },
                  "required": [
                    "sku_quantity",
                    "item_id",
                    "price",
                    "sku_id"
                  ],
                  "additionalProperties": false,
                  "description": "promotion discount info for sku"
                },
                "maxItems": 100,
                "description": "promotion discount info for sku"
              },
              "id": {
                "type": "number",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "store flash sale promotion id"
              }
            },
            "required": [
              "sku_model_list",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "parameters"
        ],
        "additionalProperties": false
      },
      "outputs": [
        {
          "name": "success",
          "type": "Boolean",
          "required": true
        },
        {
          "name": "error_code",
          "type": "String",
          "required": true
        },
        {
          "name": "error_msg",
          "type": "String",
          "required": true
        }
      ],
      "outcomes": [
        {
          "path": [
            "success"
          ],
          "name": "success",
          "neutral_values": []
        },
        {
          "path": [
            "error_code"
          ],
          "name": "error_code",
          "neutral_values": [
            "null"
          ]
        }
      ]
    }
  },
  "unavailable_methods": {
    "/auth/token/create": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/auth/token/createWithOpenId": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/auth/token/refresh": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/fbi/download/startExportByDataset": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/seller/cb/country/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/seller/cb/register/info": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/seller/cb/country/location/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/seller/cb/payment/config": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/hunting/buybox/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/seller/cb/register/fieldcheck": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/seller/ar/config/syn": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/tps/runsheets/stops": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/tps/stations/create": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/ldp/createConsolidationService": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/dop/scan": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/stations/dop/scan": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/tps/stations/update": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/ldp/updateLastmile": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/tps/sellers/pickup_timeslot": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/cngfc/fulfill/getchannelcode": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/cnpms/bigbag/lable/getPdf": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/cnpms/bigbag/cancel": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/cnpms/bigbag/querycollection": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/cnpms/bigbag/commit": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/cnpms/bigbag/update": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/cnpms/account/bind": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/cnpms/address/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/cnpms/bigbag/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/membership/linkmember/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/partner/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/membership/linkmember/list": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/partner/list": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/membership/link": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/partner/link": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/partner/transaction": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/partner/unlink": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/partner/update": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/partner/updatePartnerUserId": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/customers/external_relationships_bundle": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/customers/external_relationships": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/customers/warehouses": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/service/delivery_options": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/packages/cancel": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/packages/cancel/v3": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/packages/consign": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/packages/consign/v2": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/packages": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/packages/update": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/packages/awb": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/packages/rts": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/packages/reattempt": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/fulfillment/upload_awb": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/xspace/create": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/xspace/detail": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/xspace/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/xspace/rate": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/estimate_shipping_fee": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/epis/get_shipping_fee": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/eticket/code/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/eticket/ma/available": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/eticket/ma/consume": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/eticket/ma/failsend": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/eticket/ma/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/eticket/ma/queryTbMa": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/eticket/ma/send": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/eticket/code/consume": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/insurance/promotion/collectBenefit": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/lazadapay/v1/debit/consult_payment": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/insurance/subscription/create": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/service/createorder": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/service/getPaymentStatus": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/service/updateFulfillemtStatus": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/order/alterStatus": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/order/create": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/order/getStatus": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/insurance/subscription/getSubscription": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/insurance/order/alterStatus": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/insurance/order/create": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/insurance/promotion/getPromotions": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/insurance/order/getStatus": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/insurance/syncCDP": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/rpa/id/tax/callback": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/wallet/open/service/balance/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/wallet/open/service/kyc/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/wallet/open/service/withdraw": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/wallet/open/service/withdraw/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/insurance/addon/orders/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/insurance/promotion/queryBenefit": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/wallet/open/service/reconciliation": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/insurance/voucher/redeemVoucher": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/wallet/transfer/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/wallet/transfer/request": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/wallet/giftcode/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/wallet/giftcode/request": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/wallet/open/reconciliation": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/rss/pickup-job/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/rss/pickup-jobs/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/rss/pickupLocations/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/rss/product/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/rss/products/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/rss/stockLot/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/rss/stockLots/get": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/rss/stockLot/update": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/service/cdkCodeReceived": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/install/servicecallback": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/test/install/servicecallback": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/install/test/servicecallback": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/insurance/notification": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/insurance/test/notificationcopy": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/digital/insurance/notificationlapse": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/gproject/ads/aidc/click": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/sponsor/solutions/wallet/modifyAutoTopUpOptionOneConfig": "Persistent automatic funding requires a separately established payment authorization workflow.",
    "/sponsor/solutions/account/sign": "Terms acceptance requires a separate host consent workflow.",
    "/service/market/order/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/service/market/subs/query": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/content/cancelScheduled": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/video/block/commit": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/content/create": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/video/block/create": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/category/list": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/property/list": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/content/replySchedulePublish": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/image/upload": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/video/block/upload": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/product/validate": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/content/queryTagInfosByName": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/similar/product/search": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/mcn/content/queryReviewRecords": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/lazlive/product/highlight": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/cages/validate": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/v1/confirm-inbound": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/v1/cp/confirm-parcel-collection": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/v1/scanned-parcels/create": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/v1/scanned-parcels/delete": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/dop/confirm-inbound": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/dop/scanned-parcels": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/dop/scanned-parcels/delete": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/dop/inbounded-parcels/list": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/dop/scanned-parcels/list": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/v1/cp/scheduled-pu-parcels/list": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/v1/inbounded-parcels/list": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/list": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/v1/metadata": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/v1/scanned-parcels/list": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/v1/dop/cr-parcels/search": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/v1/cages/validate": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/logistics/station/v1/cp/validate-otp": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/ai/cancelTask": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/ai/changeFace": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/ai/changeProductBackground": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/ai/fixHand": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/ai/getTaskStatus": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/ai/productImageMatch": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant.",
    "/content/ai/tryOnCloth": "Separate application/identity or partner authorization, callback/telemetry operation, or protocol not established for the existing country-bound seller grant."
  }
};
