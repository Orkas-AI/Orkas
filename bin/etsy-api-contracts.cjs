'use strict';
// Generated offline from the pinned official Etsy OpenAPI model.
module.exports = {
  "documentation_snapshot": "2026-10-01",
  "source_sha256": "fa071fc720ca063d1ff601aabdc0dc3b3e09e4b278ef09e355c715a8646e5770",
  "methods": {
    "getBuyerTaxonomyNodes": {
      "method": "GET",
      "path": "/v3/application/buyer-taxonomy/nodes",
      "risk": "R",
      "description": "Retrieves the full hierarchy tree of buyer taxonomy nodes. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getBuyerTaxonomyNodes",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/BuyerTaxonomyNodes"
        }
      },
      "response_definitions": [
        "BuyerTaxonomyNodes",
        "BuyerTaxonomyNode"
      ],
      "scopes": []
    },
    "getPropertiesByBuyerTaxonomyId": {
      "method": "GET",
      "path": "/v3/application/buyer-taxonomy/nodes/{taxonomy_id}/properties",
      "risk": "R",
      "description": "Retrieves a list of product properties, with applicable scales and values, supported for a specific buyer taxonomy ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getPropertiesByBuyerTaxonomyId",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "taxonomy_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique numeric ID of an Etsy taxonomy node, which is a metadata category for listings organized into the seller taxonomy hierarchy tree. For example, the \"shoes\" taxonomy node (ID: 1429, level: 1) is higher in the hierarchy than \"girls' shoes\" (ID: 1440, level: 2). The taxonomy nodes assigned to a listing support access to specific standardized product scales and properties. For example, listings assigned the taxonomy nodes \"shoes\" or \"girls' shoes\" support access to the \"EU\" shoe size scale with its associated property names and IDs for EU shoe sizes, such as property `value_id`:\"1394\", and `name`:\"38\".",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "taxonomy_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "taxonomy_id"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/BuyerTaxonomyNodeProperties"
        }
      },
      "response_definitions": [
        "BuyerTaxonomyNodeProperties",
        "BuyerTaxonomyNodeProperty",
        "BuyerTaxonomyPropertyScale",
        "BuyerTaxonomyPropertyValue"
      ],
      "scopes": []
    },
    "createDraftListing": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/listings",
      "risk": "W",
      "description": "Creates a physical draft [listing](/documentation/reference#tag/ShopListing) product in a shop on the Etsy channel. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/createDraftListing",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "required": [
              "quantity",
              "title",
              "description",
              "price",
              "who_made",
              "when_made",
              "taxonomy_id"
            ],
            "properties": {
              "quantity": {
                "type": "integer",
                "description": "The positive non-zero number of products available for purchase in the listing. Note: The listing quantity is the sum of available offering quantities. You can request the quantities for individual offerings from the ListingInventory resource using the [getListingInventory](/documentation/reference#operation/getListingInventory) endpoint.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "title": {
                "type": "string",
                "description": "The listing's title string. When creating or updating a listing, valid title strings contain only letters, numbers, punctuation marks, mathematical symbols, whitespace characters, ™, ©, and ®. (regex: /[^\\p{L}\\p{Nd}\\p{P}\\p{Sm}\\p{Zs}™©®]/u) You can only use the %, :, & and + characters once each.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "A description string of the product for sale in the listing.",
                "maxLength": 262144
              },
              "price": {
                "type": "number",
                "description": "The positive non-zero price of the product. (Sold product listings are private) Note: The price is the minimum possible price. The [`getListingInventory`](/documentation/reference/#operation/getListingInventory) method requests exact prices for available offerings."
              },
              "who_made": {
                "type": "string",
                "enum": [
                  "i_did",
                  "someone_else",
                  "collective"
                ],
                "description": "An enumerated string indicating who made the product. Helps buyers locate the listing under the Handmade heading. Requires 'is_supply' and 'when_made'.",
                "maxLength": 262144
              },
              "when_made": {
                "type": "string",
                "enum": [
                  "made_to_order",
                  "2020_2026",
                  "2010_2019",
                  "2007_2009",
                  "before_2007",
                  "2000_2006",
                  "1990s",
                  "1980s",
                  "1970s",
                  "1960s",
                  "1950s",
                  "1940s",
                  "1930s",
                  "1920s",
                  "1910s",
                  "1900s",
                  "1800s",
                  "1700s",
                  "before_1700"
                ],
                "description": "An enumerated string for the era in which the maker made the product in this listing. Helps buyers locate the listing under the Vintage heading. Requires 'is_supply' and 'who_made'.",
                "maxLength": 262144
              },
              "taxonomy_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numerical taxonomy ID of the listing. See [SellerTaxonomy](/documentation/reference#tag/SellerTaxonomy) and [BuyerTaxonomy](/documentation/reference#tag/BuyerTaxonomy) for more information.",
                "maximum": 9007199254740991
              },
              "shipping_profile_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 1,
                    "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "return_policy_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 1,
                    "description": "The numeric ID of the [Return Policy](/documentation/reference#operation/getShopReturnPolicies).",
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "materials": {
                "anyOf": [
                  {
                    "type": "array",
                    "description": "A list of material strings for materials used in the product. Valid materials strings contain only letters, numbers, and whitespace characters. (regex: /[^\\p{L}\\p{Nd}\\p{Zs}]/u) Default value is null.",
                    "items": {
                      "type": "string",
                      "maxLength": 262144
                    },
                    "maxItems": 25
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "shop_section_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 1,
                    "description": "The numeric ID of the [shop section](/documentation/reference#tag/Shop-Section) for this listing. Default value is null.",
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "processing_min": {
                "anyOf": [
                  {
                    "type": "integer",
                    "description": "The minimum number of days required to process this listing. Default value is null.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "processing_max": {
                "anyOf": [
                  {
                    "type": "integer",
                    "description": "The maximum number of days required to process this listing. Default value is null.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "readiness_state_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 1,
                    "description": "The numeric ID of the [processing profile](/documentation/reference#operation/getShopReadinessStateDefinition) associated with the listing. Returned only when the listing is `active` and of type `physical`, and the endpoint is either shop-scoped (path contains `shop_id`) or a single-listing request such as `getListing`. For every other case this field can be null.",
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "tags": {
                "anyOf": [
                  {
                    "type": "array",
                    "description": "A comma-separated list of tag strings for the listing. When creating or updating a listing, valid tag strings contain only letters, numbers, whitespace characters, -, ', ™, ©, and ®. (regex: /[^\\p{L}\\p{Nd}\\p{Zs}\\-'™©®]/u) Default value is null.",
                    "items": {
                      "type": "string",
                      "maxLength": 262144
                    },
                    "maxItems": 25
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "styles": {
                "anyOf": [
                  {
                    "type": "array",
                    "description": "An array of style strings for this listing, each of which is free-form text string such as \"Formal\", or \"Steampunk\". When creating or updating a listing, the listing may have up to two styles. Valid style strings contain only letters, numbers, and whitespace characters. (regex: /[^\\p{L}\\p{Nd}\\p{Zs}]/u) Each style string is limited to 45 characters. Default value is null.",
                    "items": {
                      "type": "string",
                      "maxLength": 262144
                    },
                    "maxItems": 25
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_weight": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1.79769313486e+308,
                    "description": "The numeric weight of the product measured in units set in 'item_weight_unit'. Default value is null. If set, the value must be greater than 0."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_length": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1.79769313486e+308,
                    "description": "The numeric length of the product measured in units set in 'item_dimensions_unit'. Default value is null. If set, the value must be greater than 0."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_width": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1.79769313486e+308,
                    "description": "The numeric width of the product measured in units set in 'item_dimensions_unit'. Default value is null. If set, the value must be greater than 0."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_height": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1.79769313486e+308,
                    "description": "The numeric height of the product measured in units set in 'item_dimensions_unit'. Default value is null. If set, the value must be greater than 0."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_weight_unit": {
                "anyOf": [
                  {
                    "type": "string",
                    "enum": [
                      "oz",
                      "lb",
                      "g",
                      "kg"
                    ],
                    "description": "A string defining the units used to measure the weight of the product. Default value is null.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_dimensions_unit": {
                "anyOf": [
                  {
                    "type": "string",
                    "enum": [
                      "in",
                      "ft",
                      "mm",
                      "cm",
                      "m",
                      "yd",
                      "inches"
                    ],
                    "description": "A string defining the units used to measure the dimensions of the product. Default value is null.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "production_partner_ids": {
                "anyOf": [
                  {
                    "type": "array",
                    "description": "An array of unique IDs of production partner ids.",
                    "items": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "maxItems": 25
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "image_ids": {
                "anyOf": [
                  {
                    "type": "array",
                    "description": "An array of numeric image IDs of the images in a listing, which can include up to 20 images.",
                    "items": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "maxItems": 25
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_garan_brand": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "The brand or trademark name for the EU commercial guarantee (required under GPSR/ECGT for eligible EU traders). Maximum 25 characters. See the [Etsy Seller Handbook](https://help.etsy.com/hc/articles/43191692248343) for details. If any one of ecgt_garan_brand, ecgt_garan_model, ecgt_garan_years, or ecgt_garan_guarantee_details is provided and non-empty, all four are required. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_garan_years": {
                "anyOf": [
                  {
                    "type": "integer",
                    "description": "Duration of the EU commercial guarantee in whole years (minimum 3, maximum 99). Required together with ecgt_garan_brand, ecgt_garan_model, and ecgt_garan_guarantee_details. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_garan_model": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "The product model or reference number for the EU commercial guarantee label. Maximum 20 characters. Required together with ecgt_garan_brand, ecgt_garan_years, and ecgt_garan_guarantee_details. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_garan_guarantee_details": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Free-text description of the EU commercial guarantee terms and coverage. Maximum 255 characters. Required together with ecgt_garan_brand, ecgt_garan_model, and ecgt_garan_years. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_other_commercial_guarantee_details": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Free-text details of any additional commercial guarantee or warranty beyond the primary EU commercial guarantee. Maximum 255 characters. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_after_sales_service_info": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "After-sales service, repairability, or eco-friendly delivery information required under EU GPSR/ECGT regulations. Maximum 255 characters. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_software_update_details": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Details of software update availability and the duration of such updates, as required under EU ECGT regulations for digital content. Maximum 255 characters. Silently ignored for physical listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "is_supply": {
                "type": "boolean",
                "description": "When true, tags the listing as a supply product, else indicates that it's a finished product. Helps buyers locate the listing under the Supplies heading. Requires 'who_made' and 'when_made'."
              },
              "is_customizable": {
                "type": "boolean",
                "description": "When true, a buyer may contact the seller for a customized order. The default value is true when a shop accepts custom orders. Does not apply to shops that do not accept custom orders."
              },
              "should_auto_renew": {
                "type": "boolean",
                "description": "When true, renews a listing for four months upon expiration."
              },
              "is_taxable": {
                "type": "boolean",
                "description": "When true, applicable [shop](/documentation/reference#tag/Shop) tax rates apply to this listing at checkout."
              },
              "type": {
                "type": "string",
                "enum": [
                  "physical",
                  "download",
                  "both"
                ],
                "description": "An enumerated type string that indicates whether the listing is physical or a digital download.",
                "maxLength": 262144
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ShopListing"
        }
      },
      "response_definitions": [
        "ShopListing",
        "Money"
      ],
      "scopes": [
        "listings_w"
      ]
    },
    "getListingsByShop": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/listings",
      "risk": "R",
      "description": "Endpoint to list Listings that belong to a Shop. Listings can be filtered using the 'state' param. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingsByShop",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "active",
                  "inactive",
                  "sold_out",
                  "draft",
                  "removed",
                  "expired"
                ],
                "description": "When _updating_ a listing, this value can be either `active` or `inactive`. Note: Setting a `draft` listing to `active` will also publish the listing on etsy.com and requires that the listing have an image set. Setting a `sold_out` listing to active will update the quantity to 1 and renew the listing on etsy.com.",
                "maxLength": 262144
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              },
              "sort_on": {
                "type": "string",
                "enum": [
                  "created",
                  "price",
                  "updated",
                  "score"
                ],
                "description": "The value to sort a search result of listings on. NOTES: a) `sort_on` only works when combined with one of the search options (keywords, region, etc.). b) when using `score` the returned results will always be in _descending_ order, regardless of the `sort_order` parameter.",
                "maxLength": 262144
              },
              "sort_order": {
                "type": "string",
                "enum": [
                  "asc",
                  "ascending",
                  "desc",
                  "descending",
                  "up",
                  "down"
                ],
                "description": "The ascending(up) or descending(down) order to sort listings by. NOTE: sort_order only works when combined with one of the search options (keywords, region, etc.).",
                "maxLength": 262144
              },
              "includes": {
                "type": "array",
                "description": "An enumerated string that attaches a valid association. Acceptable inputs are 'Shipping', 'Shop', 'Images', 'User', 'Translations', 'Videos', 'Inventory' and 'Personalization'.",
                "items": {
                  "type": "string",
                  "enum": [
                    "Shipping",
                    "Images",
                    "Shop",
                    "User",
                    "Translations",
                    "Inventory",
                    "Videos",
                    "Personalization",
                    "BuyerPrice"
                  ],
                  "maxLength": 262144
                },
                "maxItems": 100
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "state"
        },
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        },
        {
          "location": "query",
          "name": "sort_on"
        },
        {
          "location": "query",
          "name": "sort_order"
        },
        {
          "location": "query",
          "name": "includes"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListingsWithAssociations"
        }
      },
      "response_definitions": [
        "ShopListingsWithAssociations",
        "ShopListingWithAssociations",
        "Money",
        "ShopShippingProfile",
        "ShopShippingProfileDestination",
        "ShopShippingProfileUpgrade",
        "User",
        "Shop",
        "ListingImage",
        "ListingVideo",
        "ListingInventory",
        "ListingInventoryProduct",
        "ListingInventoryProductOffering",
        "ListingPropertyValue",
        "ShopProductionPartner",
        "ListingTranslations",
        "ListingTranslation",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_ListingPersonalization",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_PersonalizationQuestion",
        "ListingBuyerPrice"
      ],
      "scopes": [
        "listings_r"
      ]
    },
    "deleteListing": {
      "method": "DELETE",
      "path": "/v3/application/listings/{listing_id}",
      "risk": "D",
      "description": "Open API V3 endpoint to delete a ShopListing. A ShopListing can be deleted only if the state is one of the following: SOLD_OUT, DRAFT, EXPIRED, INACTIVE, ACTIVE and is_available or Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteListing",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "listings_d"
      ]
    },
    "getListing": {
      "method": "GET",
      "path": "/v3/application/listings/{listing_id}",
      "risk": "R",
      "description": "Retrieves a listing record by listing ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListing",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "includes": {
                "type": "array",
                "description": "An enumerated string that attaches a valid association. Acceptable inputs are 'Shop', 'Images', 'User', 'Translations', 'Videos', 'Personalization' and 'BuyerPrice'.",
                "items": {
                  "type": "string",
                  "enum": [
                    "Images",
                    "Shop",
                    "User",
                    "Translations",
                    "Videos",
                    "Personalization",
                    "BuyerPrice"
                  ],
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "language": {
                "type": "string",
                "description": "The IETF language tag for the language of this translation. Ex: `de`, `en`, `es`, `fr`, `it`, `ja`, `nl`, `pl`, `pt`.",
                "maxLength": 262144
              },
              "allow_suggested_title": {
                "type": "boolean",
                "description": "This parameter will include in the response a suggested title for the listing, if one is available. Since suggestions are only available to the listing's owner, client must submit an oauth_access_token scoped to the owner of the listing."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "query",
          "name": "includes"
        },
        {
          "location": "query",
          "name": "language"
        },
        {
          "location": "query",
          "name": "allow_suggested_title"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListingWithAssociations"
        }
      },
      "response_definitions": [
        "ShopListingWithAssociations",
        "Money",
        "ShopShippingProfile",
        "ShopShippingProfileDestination",
        "ShopShippingProfileUpgrade",
        "User",
        "Shop",
        "ListingImage",
        "ListingVideo",
        "ListingInventory",
        "ListingInventoryProduct",
        "ListingInventoryProductOffering",
        "ListingPropertyValue",
        "ShopProductionPartner",
        "ListingTranslations",
        "ListingTranslation",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_ListingPersonalization",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_PersonalizationQuestion",
        "ListingBuyerPrice"
      ],
      "scopes": []
    },
    "deleteListingFile": {
      "method": "DELETE",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/files/{listing_file_id}",
      "risk": "D",
      "description": "Deletes a file from a specific listing. When you delete the final file for a digital listing, the listing converts into a physical listing. The response to a delete request returns Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteListingFile",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              },
              "listing_file_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique numeric ID of a file associated with a digital listing.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id",
              "listing_file_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "listing_file_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "listings_w"
      ]
    },
    "getListingFile": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/files/{listing_file_id}",
      "risk": "R",
      "description": "Retrieves a single file associated with the given digital listing. Requesting a file from a physical listing returns an empty result. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingFile",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              },
              "listing_file_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique numeric ID of a file associated with a digital listing.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id",
              "listing_file_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "listing_file_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListingFile"
        }
      },
      "response_definitions": [
        "ShopListingFile"
      ],
      "scopes": [
        "listings_r"
      ]
    },
    "getAllListingFiles": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/files",
      "risk": "R",
      "description": "Retrieves all the files associated with the given digital listing. Requesting files from a physical listing returns an empty result. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getAllListingFiles",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListingFiles"
        }
      },
      "response_definitions": [
        "ShopListingFiles",
        "ShopListingFile"
      ],
      "scopes": [
        "listings_r"
      ]
    },
    "uploadListingFile": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/files",
      "risk": "H",
      "description": "Uploads a new file for a digital listing, or associates an existing file with a specific listing. You must either provide the `listing_file_id` of an existing file, or the name and Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/uploadListingFile",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "listing_file_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique numeric ID of a file associated with a digital listing.",
                "maximum": 9007199254740991
              },
              "file": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Canonical base64 bytes for a bounded inline upload. No local path or URL.",
                    "maxLength": 262144,
                    "minLength": 4,
                    "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "name": {
                "type": "string",
                "description": "The file name string of a file to upload",
                "maxLength": 262144
              },
              "rank": {
                "type": "integer",
                "minimum": 1,
                "description": "The positive non-zero numeric position in the images displayed in a listing, with rank 1 images appearing in the left-most position in a listing.",
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false,
            "anyOf": [
              {
                "required": [
                  "listing_file_id"
                ]
              },
              {
                "required": [
                  "file",
                  "name"
                ],
                "properties": {
                  "file": {
                    "type": "string",
                    "minLength": 4
                  },
                  "name": {
                    "type": "string",
                    "minLength": 1
                  }
                }
              }
            ]
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "multipart/form-data",
      "binary": [
        "file"
      ],
      "responses": {
        "201": {
          "$ref": "#/$defs/ShopListingFile"
        }
      },
      "response_definitions": [
        "ShopListingFile"
      ],
      "scopes": [
        "listings_w"
      ]
    },
    "findAllListingsActive": {
      "method": "GET",
      "path": "/v3/application/listings/active",
      "risk": "R",
      "description": "A list of all active listings on Etsy paginated by their creation date. Without sort_order listings will be returned newest-first by default. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/findAllListingsActive",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              },
              "keywords": {
                "type": "string",
                "description": "Search term or phrase that must appear in all results.",
                "maxLength": 262144
              },
              "sort_on": {
                "type": "string",
                "enum": [
                  "created",
                  "price",
                  "updated",
                  "score"
                ],
                "description": "The value to sort a search result of listings on. NOTES: a) `sort_on` only works when combined with one of the search options (keywords, region, etc.). b) when using `score` the returned results will always be in _descending_ order, regardless of the `sort_order` parameter.",
                "maxLength": 262144
              },
              "sort_order": {
                "type": "string",
                "enum": [
                  "asc",
                  "ascending",
                  "desc",
                  "descending",
                  "up",
                  "down"
                ],
                "description": "The ascending(up) or descending(down) order to sort listings by. NOTE: sort_order only works when combined with one of the search options (keywords, region, etc.).",
                "maxLength": 262144
              },
              "min_price": {
                "type": "number",
                "description": "The minimum price of listings to be returned by a search result."
              },
              "max_price": {
                "type": "number",
                "description": "The maximum price of listings to be returned by a search result."
              },
              "taxonomy_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numerical taxonomy ID of the listing. See [SellerTaxonomy](/documentation/reference#tag/SellerTaxonomy) and [BuyerTaxonomy](/documentation/reference#tag/BuyerTaxonomy) for more information.",
                "maximum": 9007199254740991
              },
              "shop_location": {
                "type": "string",
                "description": "Filters by shop location. If location cannot be parsed, Etsy responds with an error.",
                "maxLength": 262144
              },
              "is_safe": {
                "type": "boolean",
                "description": "When true, filters out mature/adult content from search results."
              },
              "currency": {
                "type": "string",
                "description": "The ISO 4217 alphabetic currency code (e.g., EUR, MXN) for price conversion. If provided, the listing price will be converted to this currency.",
                "maxLength": 262144
              },
              "buyer_country": {
                "type": "string",
                "description": "The ISO 3166-1 alpha-2 country code (e.g., DE, MX). Filters results to listings that ship to this country.",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        },
        {
          "location": "query",
          "name": "keywords"
        },
        {
          "location": "query",
          "name": "sort_on"
        },
        {
          "location": "query",
          "name": "sort_order"
        },
        {
          "location": "query",
          "name": "min_price"
        },
        {
          "location": "query",
          "name": "max_price"
        },
        {
          "location": "query",
          "name": "taxonomy_id"
        },
        {
          "location": "query",
          "name": "shop_location"
        },
        {
          "location": "query",
          "name": "is_safe"
        },
        {
          "location": "query",
          "name": "currency"
        },
        {
          "location": "query",
          "name": "buyer_country"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListings"
        }
      },
      "response_definitions": [
        "ShopListings",
        "ShopListing",
        "Money"
      ],
      "scopes": []
    },
    "findAllActiveListingsByShop": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/listings/active",
      "risk": "R",
      "description": "Retrieves a list of all active listings on Etsy in a specific shop, paginated by listing creation date. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/findAllActiveListingsByShop",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "sort_on": {
                "type": "string",
                "enum": [
                  "created",
                  "price",
                  "updated",
                  "score"
                ],
                "description": "The value to sort a search result of listings on. NOTES: a) `sort_on` only works when combined with one of the search options (keywords, region, etc.). b) when using `score` the returned results will always be in _descending_ order, regardless of the `sort_order` parameter.",
                "maxLength": 262144
              },
              "sort_order": {
                "type": "string",
                "enum": [
                  "asc",
                  "ascending",
                  "desc",
                  "descending",
                  "up",
                  "down"
                ],
                "description": "The ascending(up) or descending(down) order to sort listings by. NOTE: sort_order only works when combined with one of the search options (keywords, region, etc.).",
                "maxLength": 262144
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              },
              "keywords": {
                "type": "string",
                "description": "Search term or phrase that must appear in all results.",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "sort_on"
        },
        {
          "location": "query",
          "name": "sort_order"
        },
        {
          "location": "query",
          "name": "offset"
        },
        {
          "location": "query",
          "name": "keywords"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListings"
        }
      },
      "response_definitions": [
        "ShopListings",
        "ShopListing",
        "Money"
      ],
      "scopes": []
    },
    "deleteListingImage": {
      "method": "DELETE",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/images/{listing_image_id}",
      "risk": "D",
      "description": "Open API V3 endpoint to delete a listing image. A copy of the file remains on our servers, and so a deleted image may be re-associated with the listing without re-uploading the ori Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteListingImage",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              },
              "listing_image_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the primary [listing image](/documentation/reference#tag/ShopListing-Image) for this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id",
              "listing_image_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "listing_image_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "listings_w"
      ]
    },
    "getListingImage": {
      "method": "GET",
      "path": "/v3/application/listings/{listing_id}/images/{listing_image_id}",
      "risk": "R",
      "description": "Retrieves the references and metadata for a listing image with a specific image ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingImage",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              },
              "listing_image_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the primary [listing image](/documentation/reference#tag/ShopListing-Image) for this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id",
              "listing_image_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "listing_image_id"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingImage"
        }
      },
      "response_definitions": [
        "ListingImage"
      ],
      "scopes": []
    },
    "getListingImages": {
      "method": "GET",
      "path": "/v3/application/listings/{listing_id}/images",
      "risk": "R",
      "description": "Retrieves all listing image resources for a listing with a specific listing ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingImages",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingImages"
        }
      },
      "response_definitions": [
        "ListingImages",
        "ListingImage"
      ],
      "scopes": []
    },
    "uploadListingImage": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/images",
      "risk": "H",
      "description": "Uploads or assigns an image to a listing identified by a shop ID with a listing ID. To upload a new image, set the image file as the value for the `image` parameter. You can assign Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/uploadListingImage",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "image": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Canonical base64 bytes for a bounded inline upload. No local path or URL.",
                    "maxLength": 262144,
                    "minLength": 4,
                    "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "listing_image_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the primary [listing image](/documentation/reference#tag/ShopListing-Image) for this transaction.",
                "maximum": 9007199254740991
              },
              "rank": {
                "type": "integer",
                "minimum": 0,
                "description": "The positive non-zero numeric position in the images displayed in a listing, with rank 1 images appearing in the left-most position in a listing.",
                "maximum": 9007199254740991
              },
              "overwrite": {
                "type": "boolean",
                "description": "When true, this request replaces the existing image at a given rank."
              },
              "is_watermarked": {
                "type": "boolean",
                "description": "When true, indicates that the uploaded image has a watermark."
              },
              "alt_text": {
                "type": "string",
                "description": "Alt text for the listing image. Max length 500 characters.",
                "maxLength": 262144
              }
            },
            "additionalProperties": false,
            "anyOf": [
              {
                "required": [
                  "listing_image_id"
                ]
              },
              {
                "required": [
                  "image"
                ],
                "properties": {
                  "image": {
                    "type": "string",
                    "minLength": 4
                  }
                }
              }
            ]
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "multipart/form-data",
      "binary": [
        "image"
      ],
      "responses": {
        "201": {
          "$ref": "#/$defs/ListingImage"
        }
      },
      "response_definitions": [
        "ListingImage"
      ],
      "scopes": [
        "listings_w"
      ]
    },
    "getListingInventory": {
      "method": "GET",
      "path": "/v3/application/listings/{listing_id}/inventory",
      "risk": "R",
      "description": "Retrieves the inventory record for a listing. Listings you did not edit using the Etsy.com inventory tools have no inventory records. This endpoint returns SKU data if you are the  Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingInventory",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "show_deleted": {
                "type": "boolean",
                "description": "A boolean value for inventory whether to include deleted products and their offerings. Default value is false."
              },
              "includes": {
                "type": "string",
                "enum": [
                  "Listing"
                ],
                "description": "An enumerated string that attaches a valid association. Default value is null.",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "query",
          "name": "show_deleted"
        },
        {
          "location": "query",
          "name": "includes"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingInventoryWithAssociations"
        }
      },
      "response_definitions": [
        "ListingInventoryWithAssociations",
        "ListingInventoryProduct",
        "ListingInventoryProductOffering",
        "Money",
        "ListingPropertyValue",
        "ShopListing"
      ],
      "scopes": [
        "listings_r"
      ]
    },
    "updateListingInventory": {
      "method": "PUT",
      "path": "/v3/application/listings/{listing_id}/inventory",
      "risk": "H",
      "description": "Updates the inventory for a listing identified by a listing ID. The update fails if the supplied values for product sku, offering quantity, price, and/or processing profile are inc Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateListingInventory",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "max_variations_supported": {
                "type": "string",
                "enum": [
                  "2",
                  "3"
                ],
                "description": "This parameter determines whether a third variation can be added to or updated for a listing. It accepts values of 2 or 3, where 3 enables third-variation support.",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "required": [
              "products"
            ],
            "properties": {
              "products": {
                "type": "array",
                "description": "A JSON array of products available in a listing, even if only one product. All field names in the JSON blobs are lowercase.",
                "items": {
                  "type": "object",
                  "required": [
                    "offerings"
                  ],
                  "properties": {
                    "sku": {
                      "anyOf": [
                        {
                          "type": "string",
                          "description": "The SKU string for the product",
                          "maxLength": 262144
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "property_values": {
                      "type": "array",
                      "description": "A list of property value entries for this product. Note: parenthesis characters (`(` and `)`) are not allowed.",
                      "items": {
                        "type": "object",
                        "required": [
                          "property_id",
                          "value_ids",
                          "values"
                        ],
                        "properties": {
                          "property_id": {
                            "type": "integer",
                            "minimum": 1,
                            "description": "The unique ID of an Etsy [listing property](/documentation/reference#operation/getListingInventory).",
                            "maximum": 9007199254740991
                          },
                          "value_ids": {
                            "type": "array",
                            "description": "An array of unique IDs of Etsy [listing property](/documentation/reference#operation/getListingInventory) values.",
                            "items": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 9007199254740991
                            },
                            "maxItems": 10
                          },
                          "scale_id": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "minimum": 1,
                                "description": "The numeric ID of a single Etsy.com measurement scale. For example, for shoe size, there are three `scale_id`s available - `UK`, `US/Canada`, and `EU`, where `US/Canada` has `scale_id` 19.",
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "property_name": {
                            "type": "string",
                            "description": "The name of the property, in the requested locale language.",
                            "maxLength": 262144
                          },
                          "values": {
                            "type": "array",
                            "description": "A list of property value entries for this product. Note: parenthesis characters (`(` and `)`) are not allowed.",
                            "items": {
                              "type": "string",
                              "maxLength": 262144
                            },
                            "maxItems": 10
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "offerings": {
                      "type": "array",
                      "description": "A list of product offering entries for this product.",
                      "items": {
                        "type": "object",
                        "required": [
                          "price",
                          "quantity",
                          "is_enabled",
                          "readiness_state_id"
                        ],
                        "properties": {
                          "price": {
                            "type": "number",
                            "description": "The price of the product."
                          },
                          "quantity": {
                            "type": "integer",
                            "description": "How many of this product are available?",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "is_enabled": {
                            "type": "boolean",
                            "description": "True if the offering is shown to buyers"
                          },
                          "readiness_state_id": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "minimum": 1,
                                "description": "The numeric ID of the [processing profile](/documentation/reference#operation/getShopReadinessStateDefinition) associated with the listing. Returned only when the listing is `active` and of type `physical`, and the endpoint is either shop-scoped (path contains `shop_id`) or a single-listing request such as `getListing`. For every other case this field can be null.",
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "price_on_property": {
                "type": "array",
                "description": "An array of unique [listing property](/documentation/reference#operation/getListingInventory) ID integers for the properties that change product prices, if any. For example, if you charge specific prices for different sized products in the same listing, then this array contains the property ID for size.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "quantity_on_property": {
                "type": "array",
                "description": "An array of unique [listing property](/documentation/reference#operation/getListingInventory) ID integers for the properties that change the quantity of the products, if any. For example, if you stock specific quantities of different colored products in the same listing, then this array contains the property ID for color.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "sku_on_property": {
                "type": "array",
                "description": "An array of unique [listing property](/documentation/reference#operation/getListingInventory) ID integers for the properties that change the product SKU, if any. For example, if you use specific skus for different colored products in the same listing, then this array contains the property ID for color.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "readiness_state_on_property": {
                "anyOf": [
                  {
                    "type": "array",
                    "description": "An array of unique [listing property](/documentation/reference#operation/getListingInventory) ID integers for the properties that change processing profile, if any. For example, if you need specific processing profiles for different colored products in the same listing, then this array contains the property ID for color.",
                    "items": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "maxItems": 10
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "query",
          "name": "max_variations_supported"
        }
      ],
      "bindings": [],
      "media": "application/json",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingInventory"
        }
      },
      "response_definitions": [
        "ListingInventory",
        "ListingInventoryProduct",
        "ListingInventoryProductOffering",
        "Money",
        "ListingPropertyValue"
      ],
      "scopes": [
        "listings_w"
      ]
    },
    "getListingsInventoryByListingIds": {
      "method": "GET",
      "path": "/v3/application/listings/batch/inventory",
      "risk": "R",
      "description": "Retrieves the inventory record for each listing referenced by listing ID. Requires the `listings_r` OAuth scope. Limit 100 listing IDs per request. All requested listing IDs must e Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingsInventoryByListingIds",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "listing_ids": {
                "type": "array",
                "description": "The list of numeric IDS for the listings in a specific Etsy shop.",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              }
            },
            "required": [
              "listing_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "listing_ids"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListingsWithAssociations"
        }
      },
      "response_definitions": [
        "ShopListingsWithAssociations",
        "ShopListingWithAssociations",
        "Money",
        "ShopShippingProfile",
        "ShopShippingProfileDestination",
        "ShopShippingProfileUpgrade",
        "User",
        "Shop",
        "ListingImage",
        "ListingVideo",
        "ListingInventory",
        "ListingInventoryProduct",
        "ListingInventoryProductOffering",
        "ListingPropertyValue",
        "ShopProductionPartner",
        "ListingTranslations",
        "ListingTranslation",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_ListingPersonalization",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_PersonalizationQuestion",
        "ListingBuyerPrice"
      ],
      "scopes": [
        "listings_r"
      ]
    },
    "getListingProduct": {
      "method": "GET",
      "path": "/v3/application/listings/{listing_id}/inventory/products/{product_id}",
      "risk": "R",
      "description": "Open API V3 endpoint to retrieve a ListingProduct by ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingProduct",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The listing to return a ListingProduct for.",
                "maximum": 9007199254740991
              },
              "product_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for a specific [product](/documentation/reference#tag/ShopListing-Product) purchased from a listing.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id",
              "product_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "legacy": {
                "type": "boolean",
                "description": "This parameter is needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "product_id"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingInventoryProduct"
        }
      },
      "response_definitions": [
        "ListingInventoryProduct",
        "ListingInventoryProductOffering",
        "Money",
        "ListingPropertyValue"
      ],
      "scopes": [
        "listings_r"
      ]
    },
    "getListingOffering": {
      "method": "GET",
      "path": "/v3/application/listings/{listing_id}/products/{product_id}/offerings/{product_offering_id}",
      "risk": "R",
      "description": "Get an Offering for a Listing Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingOffering",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "product_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "product_offering_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id",
              "product_id",
              "product_offering_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "legacy": {
                "type": "boolean",
                "description": "This parameter is needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "product_id"
        },
        {
          "location": "path",
          "name": "product_offering_id"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingInventoryProductOffering"
        }
      },
      "response_definitions": [
        "ListingInventoryProductOffering",
        "Money"
      ],
      "scopes": []
    },
    "getListingsByListingIds": {
      "method": "GET",
      "path": "/v3/application/listings/batch",
      "risk": "R",
      "description": "Allows to query multiple listing ids at once. Limit 100 ids maximum per query. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingsByListingIds",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "listing_ids": {
                "type": "array",
                "description": "The list of numeric IDS for the listings in a specific Etsy shop.",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "includes": {
                "type": "array",
                "description": "An enumerated string that attaches a valid association. Acceptable inputs are 'Shop', 'Images', 'User', 'Translations', 'Videos', 'Personalization' and 'BuyerPrice'.",
                "items": {
                  "type": "string",
                  "enum": [
                    "Images",
                    "Shop",
                    "User",
                    "Translations",
                    "Videos",
                    "Personalization",
                    "BuyerPrice"
                  ],
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "legacy": {
                "type": "boolean",
                "description": "This parameter is needed to enable new parameters and response values related to processing profiles."
              },
              "currency": {
                "type": "string",
                "description": "The ISO 4217 alphabetic currency code (e.g., EUR, MXN) for price conversion. If provided, the listing price will be converted to this currency.",
                "maxLength": 262144
              },
              "buyer_country": {
                "type": "string",
                "description": "The ISO 3166-1 alpha-2 country code (e.g., GB, DE). Used for buyer-facing price calculations (VAT, inclusive shipping). Does not filter listings.",
                "maxLength": 262144
              }
            },
            "required": [
              "listing_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "listing_ids"
        },
        {
          "location": "query",
          "name": "includes"
        },
        {
          "location": "query",
          "name": "legacy"
        },
        {
          "location": "query",
          "name": "currency"
        },
        {
          "location": "query",
          "name": "buyer_country"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListingsWithAssociations"
        }
      },
      "response_definitions": [
        "ShopListingsWithAssociations",
        "ShopListingWithAssociations",
        "Money",
        "ShopShippingProfile",
        "ShopShippingProfileDestination",
        "ShopShippingProfileUpgrade",
        "User",
        "Shop",
        "ListingImage",
        "ListingVideo",
        "ListingInventory",
        "ListingInventoryProduct",
        "ListingInventoryProductOffering",
        "ListingPropertyValue",
        "ShopProductionPartner",
        "ListingTranslations",
        "ListingTranslation",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_ListingPersonalization",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_PersonalizationQuestion",
        "ListingBuyerPrice"
      ],
      "scopes": []
    },
    "getFeaturedListingsByShop": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/listings/featured",
      "risk": "R",
      "description": "Retrieves Listings associated to a Shop that are featured. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getFeaturedListingsByShop",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              },
              "legacy": {
                "type": "boolean",
                "description": "This parameter is needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListings"
        }
      },
      "response_definitions": [
        "ShopListings",
        "ShopListing",
        "Money"
      ],
      "scopes": []
    },
    "deleteListingPersonalization": {
      "method": "DELETE",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/personalization",
      "risk": "D",
      "description": "Deletes personalization for a listing. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteListingPersonalization",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "listings_w"
      ]
    },
    "updateListingPersonalization": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/personalization",
      "risk": "H",
      "description": "Creates or updates personalization settings for a listing, allowing the seller to collect personalization from the buyer. This endpoint will fully replace any existing personalizat Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateListingPersonalization",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "supports_multiple_personalization_questions": {
                "anyOf": [
                  {
                    "type": "boolean",
                    "description": "This query parameter indicates that the caller supports up to 5 personalization questions and the following question types: 'text_input', 'dropdown', 'unlabeled_upload', 'labeled_upload'. Sending this param without updating your application can lead to inadvertently deleting seller-entered data."
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "required": [
              "personalization_questions"
            ],
            "properties": {
              "personalization_questions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "question_text",
                    "question_type",
                    "required"
                  ],
                  "properties": {
                    "question_id": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "minimum": 1,
                          "description": "The ID of the personalization question. This field is optional. Include it when updating an existing question; omit it when creating a new question. Note: This value may change if the personalization question is updated.",
                          "maximum": 9007199254740991
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "question_text": {
                      "type": "string",
                      "description": "The title of the personalization question. Must be between 1 and 45 characters. See https://developers.etsy.com/documentation/tutorials/personalization-migration#writing-listing-personalization-data",
                      "maxLength": 262144
                    },
                    "instructions": {
                      "anyOf": [
                        {
                          "type": "string",
                          "description": "Optional instructions for a personalization question. This field is not allowed for 'dropdown' questions. See https://developers.etsy.com/documentation/tutorials/personalization-migration#writing-listing-personalization-data",
                          "maxLength": 262144
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "question_type": {
                      "type": "string",
                      "enum": [
                        "text_input",
                        "dropdown",
                        "unlabeled_upload",
                        "labeled_upload"
                      ],
                      "description": "The type of the personalization question. Note: Currently, only a single question with type 'text_input' is supported. See https://developers.etsy.com/documentation/tutorials/personalization-migration for details about new question types.",
                      "maxLength": 262144
                    },
                    "required": {
                      "type": "boolean",
                      "description": "When true, the personalization question is required."
                    },
                    "max_allowed_files": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "description": "The maximum number of files the buyer may upload in response to a personalization question. This field is optional and only applicable to 'unlabeled_upload' and 'labeled_upload' questions.",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "max_allowed_characters": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "description": "The maximum number of characters the buyer may enter in response to a personalization question. This field is optional and only applicable to 'text_input' questions.",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "options": {
                      "anyOf": [
                        {
                          "type": "array",
                          "description": "The list of options for a personalization question. For 'dropdown' questions, this list contains the options for the dropdown. For 'labeled_upload' questions, this list contains the labels for the files that the buyer may upload, and must match the max_allowed_files value..",
                          "items": {
                            "type": "object",
                            "required": [
                              "label"
                            ],
                            "properties": {
                              "option_id": {
                                "anyOf": [
                                  {
                                    "type": "integer",
                                    "minimum": 1,
                                    "description": "The ID of the option. This field is optional. Include it when updating an existing option; omit it when creating a new option. Note: This value may change if the option or question is updated.",
                                    "maximum": 9007199254740991
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "label": {
                                "type": "string",
                                "description": "The option label. Note: For 'dropdown' questions, max length is 20 characters. For 'labeled_upload' questions, max length is 45 characters.",
                                "maxLength": 262144
                              }
                            },
                            "additionalProperties": false
                          },
                          "maxItems": 10
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "add_on_price": {
                      "anyOf": [
                        {
                          "type": "number",
                          "description": "The add-on price for a question. This field is optional and only supported for optional questions of type text_input."
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "query",
          "name": "supports_multiple_personalization_questions"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/json",
      "binary": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_ListingPersonalization"
        }
      },
      "response_definitions": [
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_ListingPersonalization",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_PersonalizationQuestion",
        "Money"
      ],
      "scopes": [
        "listings_w"
      ]
    },
    "getListingPersonalization": {
      "method": "GET",
      "path": "/v3/application/listings/{listing_id}/personalization",
      "risk": "R",
      "description": "Retrieves a listing's personalization questions by listing ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingPersonalization",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_ListingPersonalization"
        }
      },
      "response_definitions": [
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_ListingPersonalization",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_PersonalizationQuestion",
        "Money"
      ],
      "scopes": []
    },
    "deleteListingProperty": {
      "method": "DELETE",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/properties/{property_id}",
      "risk": "D",
      "description": "Deletes a property for a Listing. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteListingProperty",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              },
              "property_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique ID of an Etsy [listing property](/documentation/reference#operation/getListingProperties).",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id",
              "property_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "property_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "listings_w"
      ]
    },
    "updateListingProperty": {
      "method": "PUT",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/properties/{property_id}",
      "risk": "H",
      "description": "Updates or populates the properties list defining product offerings for a listing. Each offering requires both a `value` and a `value_id` that are valid for a `scale_id` assigned t Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateListingProperty",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              },
              "property_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique ID of an Etsy [listing property](/documentation/reference#operation/getListingProperties).",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id",
              "property_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "required": [
              "value_ids",
              "values"
            ],
            "properties": {
              "value_ids": {
                "type": "array",
                "description": "An array of unique IDs of multiple Etsy [listing property](/documentation/reference#operation/getListingProperties) values. For example, if your listing is composed of different materials, then the value ID list contains value IDs for each material.",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "values": {
                "type": "array",
                "description": "An array of value strings for multiple Etsy [listing property](/documentation/reference#operation/getListingProperties) values. For example, if your listing is painted in different colors, then the values array contains the color strings for each color. Note: parenthesis characters (`(` and `)`) are not allowed.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "scale_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of a single Etsy.com measurement scale. For example, for shoe size, there are three `scale_id`s available - `UK`, `US/Canada`, and `EU`, where `US/Canada` has `scale_id` 19.",
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "property_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingPropertyValue"
        }
      },
      "response_definitions": [
        "ListingPropertyValue"
      ],
      "scopes": [
        "listings_w"
      ]
    },
    "getListingProperty": {
      "method": "GET",
      "path": "/v3/application/listings/{listing_id}/properties/{property_id}",
      "risk": "R",
      "description": "Retrieves a listing's property Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingProperty",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              },
              "property_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique ID of an Etsy [listing property](/documentation/reference#operation/getListingProperties).",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id",
              "property_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "property_id"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingPropertyValue"
        }
      },
      "response_definitions": [
        "ListingPropertyValue"
      ],
      "scopes": []
    },
    "getListingProperties": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/properties",
      "risk": "R",
      "description": "Get a listing's properties Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingProperties",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingPropertyValues"
        }
      },
      "response_definitions": [
        "ListingPropertyValues",
        "ListingPropertyValue"
      ],
      "scopes": []
    },
    "getListingsShippingByListingIds": {
      "method": "GET",
      "path": "/v3/application/listings/batch/shipping",
      "risk": "R",
      "description": "Retrieves the shipping profile for each listing referenced by listing ID. Requires the `shops_r` OAuth scope. Limit 100 listing IDs per request. All requested listing IDs must exis Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingsShippingByListingIds",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "listing_ids": {
                "type": "array",
                "description": "The list of numeric IDS for the listings in a specific Etsy shop.",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              }
            },
            "required": [
              "listing_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "listing_ids"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListingsWithAssociations"
        }
      },
      "response_definitions": [
        "ShopListingsWithAssociations",
        "ShopListingWithAssociations",
        "Money",
        "ShopShippingProfile",
        "ShopShippingProfileDestination",
        "ShopShippingProfileUpgrade",
        "User",
        "Shop",
        "ListingImage",
        "ListingVideo",
        "ListingInventory",
        "ListingInventoryProduct",
        "ListingInventoryProductOffering",
        "ListingPropertyValue",
        "ShopProductionPartner",
        "ListingTranslations",
        "ListingTranslation",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_ListingPersonalization",
        "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_PersonalizationQuestion",
        "ListingBuyerPrice"
      ],
      "scopes": [
        "shops_r"
      ]
    },
    "getShopReceiptTransactionsByListing": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/transactions",
      "risk": "R",
      "description": "Retrieves the list of transactions associated with a listing. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopReceiptTransactionsByListing",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              },
              "legacy": {
                "type": "boolean",
                "description": "This parameter needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReceiptTransactions"
        }
      },
      "response_definitions": [
        "ShopReceiptTransactions",
        "ShopReceiptTransaction",
        "Money",
        "TransactionVariations",
        "ListingPropertyValue"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "createListingTranslation": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/translations/{language}",
      "risk": "H",
      "description": "Creates a ListingTranslation by listing_id and language Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/createListingTranslation",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              },
              "language": {
                "type": "string",
                "description": "The IETF language tag for the language of this translation. Ex: `de`, `en`, `es`, `fr`, `it`, `ja`, `nl`, `pl`, `pt`.",
                "maxLength": 262144
              }
            },
            "required": [
              "listing_id",
              "language"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "required": [
              "title",
              "description"
            ],
            "properties": {
              "title": {
                "type": "string",
                "description": "The title of the Listing of this Translation.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "The description of the Listing of this Translation.",
                "maxLength": 262144
              },
              "tags": {
                "type": "array",
                "description": "The tags of the Listing of this Translation.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "language"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingTranslation"
        }
      },
      "response_definitions": [
        "ListingTranslation"
      ],
      "scopes": [
        "listings_w"
      ]
    },
    "getListingTranslation": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/translations/{language}",
      "risk": "R",
      "description": "Get a Translation for a Listing in the given language Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingTranslation",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              },
              "language": {
                "type": "string",
                "description": "The IETF language tag for the language of this translation. Ex: `de`, `en`, `es`, `fr`, `it`, `ja`, `nl`, `pl`, `pt`.",
                "maxLength": 262144
              }
            },
            "required": [
              "listing_id",
              "language"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "language"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingTranslation"
        }
      },
      "response_definitions": [
        "ListingTranslation"
      ],
      "scopes": []
    },
    "updateListingTranslation": {
      "method": "PUT",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/translations/{language}",
      "risk": "H",
      "description": "Updates a ListingTranslation by listing_id and language Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateListingTranslation",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              },
              "language": {
                "type": "string",
                "description": "The IETF language tag for the language of this translation. Ex: `de`, `en`, `es`, `fr`, `it`, `ja`, `nl`, `pl`, `pt`.",
                "maxLength": 262144
              }
            },
            "required": [
              "listing_id",
              "language"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "required": [
              "title",
              "description"
            ],
            "properties": {
              "title": {
                "type": "string",
                "description": "The title of the Listing of this Translation.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "The description of the Listing of this Translation.",
                "maxLength": 262144
              },
              "tags": {
                "type": "array",
                "description": "The tags of the Listing of this Translation.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "language"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingTranslation"
        }
      },
      "response_definitions": [
        "ListingTranslation"
      ],
      "scopes": [
        "listings_w"
      ]
    },
    "updateListing": {
      "method": "PATCH",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}",
      "risk": "H",
      "description": "Updates a listing, identified by a listing ID, for a specific shop identified by a shop ID. Note that this is a PATCH method type. When activating, or manually renewing a physical  Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateListing",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "image_ids": {
                "type": "array",
                "description": "An array of numeric image IDs of the images in a listing, which can include up to 20 images.",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "title": {
                "type": "string",
                "description": "The listing's title string. When creating or updating a listing, valid title strings contain only letters, numbers, punctuation marks, mathematical symbols, whitespace characters, ™, ©, and ®. (regex: /[^\\p{L}\\p{Nd}\\p{P}\\p{Sm}\\p{Zs}™©®]/u) You can only use the %, :, & and + characters once each.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "A description string of the product for sale in the listing.",
                "maxLength": 262144
              },
              "materials": {
                "anyOf": [
                  {
                    "type": "array",
                    "description": "A list of material strings for materials used in the product. Valid materials strings contain only letters, numbers, and whitespace characters. (regex: /[^\\p{L}\\p{Nd}\\p{Zs}]/u) Default value is null.",
                    "items": {
                      "type": "string",
                      "maxLength": 262144
                    },
                    "maxItems": 10
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "should_auto_renew": {
                "type": "boolean",
                "description": "When true, renews a listing for four months upon expiration."
              },
              "shipping_profile_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 1,
                    "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "return_policy_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 1,
                    "description": "The numeric ID of the [Return Policy](/documentation/reference#operation/getShopReturnPolicies). Required for active physical listings. This requirement does not apply to listings of EU-based shops.",
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "shop_section_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "description": "The numeric ID of the [shop section](/documentation/reference#tag/Shop-Section) for this listing. Default value is null.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_weight": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1.79769313486e+308,
                    "description": "The numeric weight of the product measured in units set in 'item_weight_unit'. Default value is null. If set, the value must be greater than 0."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_length": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1.79769313486e+308,
                    "description": "The numeric length of the product measured in units set in 'item_dimensions_unit'. Default value is null. If set, the value must be greater than 0."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_width": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1.79769313486e+308,
                    "description": "The numeric width of the product measured in units set in 'item_dimensions_unit'. Default value is null. If set, the value must be greater than 0."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_height": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1.79769313486e+308,
                    "description": "The numeric height of the product measured in units set in 'item_dimensions_unit'. Default value is null. If set, the value must be greater than 0."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_weight_unit": {
                "anyOf": [
                  {
                    "type": "string",
                    "enum": [
                      "",
                      "oz",
                      "lb",
                      "g",
                      "kg"
                    ],
                    "description": "A string defining the units used to measure the weight of the product. Default value is null.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "item_dimensions_unit": {
                "anyOf": [
                  {
                    "type": "string",
                    "enum": [
                      "",
                      "in",
                      "ft",
                      "mm",
                      "cm",
                      "m",
                      "yd",
                      "inches"
                    ],
                    "description": "A string defining the units used to measure the dimensions of the product. Default value is null.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "is_taxable": {
                "type": "boolean",
                "description": "When true, applicable [shop](/documentation/reference#tag/Shop) tax rates apply to this listing at checkout."
              },
              "taxonomy_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numerical taxonomy ID of the listing. See [SellerTaxonomy](/documentation/reference#tag/SellerTaxonomy) and [BuyerTaxonomy](/documentation/reference#tag/BuyerTaxonomy) for more information.",
                "maximum": 9007199254740991
              },
              "tags": {
                "anyOf": [
                  {
                    "type": "array",
                    "description": "A comma-separated list of tag strings for the listing. When creating or updating a listing, valid tag strings contain only letters, numbers, whitespace characters, -, ', ™, ©, and ®. (regex: /[^\\p{L}\\p{Nd}\\p{Zs}\\-'™©®]/u) Default value is null.",
                    "items": {
                      "type": "string",
                      "maxLength": 262144
                    },
                    "maxItems": 10
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "who_made": {
                "type": "string",
                "enum": [
                  "i_did",
                  "someone_else",
                  "collective"
                ],
                "description": "An enumerated string indicating who made the product. Helps buyers locate the listing under the Handmade heading. Requires 'is_supply' and 'when_made'.",
                "maxLength": 262144
              },
              "when_made": {
                "type": "string",
                "enum": [
                  "made_to_order",
                  "2020_2026",
                  "2010_2019",
                  "2007_2009",
                  "before_2007",
                  "2000_2006",
                  "1990s",
                  "1980s",
                  "1970s",
                  "1960s",
                  "1950s",
                  "1940s",
                  "1930s",
                  "1920s",
                  "1910s",
                  "1900s",
                  "1800s",
                  "1700s",
                  "before_1700"
                ],
                "description": "An enumerated string for the era in which the maker made the product in this listing. Helps buyers locate the listing under the Vintage heading. Requires 'is_supply' and 'who_made'.",
                "maxLength": 262144
              },
              "featured_rank": {
                "anyOf": [
                  {
                    "type": "integer",
                    "description": "The positive non-zero numeric position in the featured listings of the shop, with rank 1 listings appearing in the left-most position in featured listing on a shop's home page.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "state": {
                "type": "string",
                "enum": [
                  "active",
                  "inactive"
                ],
                "description": "When _updating_ a listing, this value can be either `active` or `inactive`. Note: Setting a `draft` listing to `active` will also publish the listing on etsy.com and requires that the listing have an image set. Setting a `sold_out` listing to active will update the quantity to 1 and renew the listing on etsy.com.",
                "maxLength": 262144
              },
              "is_supply": {
                "type": "boolean",
                "description": "When true, tags the listing as a supply product, else indicates that it's a finished product. Helps buyers locate the listing under the Supplies heading. Requires 'who_made' and 'when_made'."
              },
              "production_partner_ids": {
                "anyOf": [
                  {
                    "type": "array",
                    "description": "An array of unique IDs of production partner ids.",
                    "items": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "maxItems": 10
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "type": {
                "anyOf": [
                  {
                    "type": "string",
                    "enum": [
                      "physical",
                      "download",
                      "both"
                    ],
                    "description": "An enumerated type string that indicates whether the listing is physical or a digital download.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_garan_brand": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "The brand or trademark name for the EU commercial guarantee (required under GPSR/ECGT for eligible EU traders). Maximum 25 characters. See the [Etsy Seller Handbook](https://help.etsy.com/hc/articles/43191692248343) for details. If any one of ecgt_garan_brand, ecgt_garan_model, ecgt_garan_years, or ecgt_garan_guarantee_details is provided and non-empty, all four are required. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_garan_years": {
                "anyOf": [
                  {
                    "type": "integer",
                    "description": "Duration of the EU commercial guarantee in whole years (minimum 3, maximum 99). Required together with ecgt_garan_brand, ecgt_garan_model, and ecgt_garan_guarantee_details. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_garan_model": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "The product model or reference number for the EU commercial guarantee label. Maximum 20 characters. Required together with ecgt_garan_brand, ecgt_garan_years, and ecgt_garan_guarantee_details. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_garan_guarantee_details": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Free-text description of the EU commercial guarantee terms and coverage. Maximum 255 characters. Required together with ecgt_garan_brand, ecgt_garan_model, and ecgt_garan_years. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_other_commercial_guarantee_details": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Free-text details of any additional commercial guarantee or warranty beyond the primary EU commercial guarantee. Maximum 255 characters. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_after_sales_service_info": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "After-sales service, repairability, or eco-friendly delivery information required under EU GPSR/ECGT regulations. Maximum 255 characters. Silently ignored for digital listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ecgt_software_update_details": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Details of software update availability and the duration of such updates, as required under EU ECGT regulations for digital content. Maximum 255 characters. Silently ignored for physical listings and for sellers who are not eligible EU traders.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListing"
        }
      },
      "response_definitions": [
        "ShopListing",
        "Money"
      ],
      "scopes": [
        "listings_w"
      ]
    },
    "getListingVariationImages": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/variation-images",
      "risk": "R",
      "description": "Gets all variation images on a listing. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingVariationImages",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingVariationImages"
        }
      },
      "response_definitions": [
        "ListingVariationImages",
        "ListingVariationImage"
      ],
      "scopes": []
    },
    "updateVariationImages": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/variation-images",
      "risk": "H",
      "description": "Creates variation images on a listing. `variation_images` is an array with inputs for the `property_id`, `value_id`, and `image_id` fields. `image_ids` are associated with a `Listi Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateVariationImages",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "required": [
              "variation_images"
            ],
            "properties": {
              "variation_images": {
                "type": "array",
                "description": "A list of variation image data.",
                "items": {
                  "type": "object",
                  "required": [
                    "property_id",
                    "value_id",
                    "image_id"
                  ],
                  "properties": {
                    "property_id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "value_id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "image_id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/json",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingVariationImages"
        }
      },
      "response_definitions": [
        "ListingVariationImages",
        "ListingVariationImage"
      ],
      "scopes": [
        "listings_w"
      ]
    },
    "deleteListingVideo": {
      "method": "DELETE",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/videos/{video_id}",
      "risk": "D",
      "description": "Open API V3 endpoint to delete a listing video. A copy of the video remains on our servers, and so a deleted video may be re-associated with the listing without re-uploading the or Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteListingVideo",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              },
              "video_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique ID of a video associated with a listing.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id",
              "video_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "path",
          "name": "video_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "listings_w"
      ]
    },
    "getListingVideo": {
      "method": "GET",
      "path": "/v3/application/listings/{listing_id}/videos/{video_id}",
      "risk": "R",
      "description": "Retrieves a single video associated with the given listing. Requesting a video from a listing returns an empty result. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingVideo",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "video_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique ID of a video associated with a listing.",
                "maximum": 9007199254740991
              },
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "video_id",
              "listing_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "video_id"
        },
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingVideo"
        }
      },
      "response_definitions": [
        "ListingVideo"
      ],
      "scopes": []
    },
    "getListingVideos": {
      "method": "GET",
      "path": "/v3/application/listings/{listing_id}/videos",
      "risk": "R",
      "description": "Retrieves all listing video resources for a listing with a specific listing ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingVideos",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingVideos"
        }
      },
      "response_definitions": [
        "ListingVideos",
        "ListingVideo"
      ],
      "scopes": []
    },
    "uploadListingVideo": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/listings/{listing_id}/videos",
      "risk": "H",
      "description": "Uploads a new video for a listing, or associates an existing video with a specific listing. You must either provide the `video_id` of an existing video, or the name and binary file Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/uploadListingVideo",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "is_multi_video": {
                "type": "boolean",
                "description": "Indicates whether to handle multiple videos for the listing or maintain the former single video behavior."
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "video_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique ID of a video associated with a listing.",
                "maximum": 9007199254740991
              },
              "video": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Canonical base64 bytes for a bounded inline upload. No local path or URL.",
                    "maxLength": 262144,
                    "minLength": 4,
                    "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "name": {
                "type": "string",
                "description": "The file name string for the video to upload.",
                "maxLength": 262144
              }
            },
            "additionalProperties": false,
            "anyOf": [
              {
                "required": [
                  "video_id"
                ]
              },
              {
                "required": [
                  "video",
                  "name"
                ],
                "properties": {
                  "video": {
                    "type": "string",
                    "minLength": 4
                  },
                  "name": {
                    "type": "string",
                    "minLength": 1
                  }
                }
              }
            ]
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "query",
          "name": "is_multi_video"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "multipart/form-data",
      "binary": [
        "video"
      ],
      "responses": {
        "201": {
          "$ref": "#/$defs/ListingVideo"
        }
      },
      "response_definitions": [
        "ListingVideo"
      ],
      "scopes": [
        "listings_w"
      ]
    },
    "getShopPaymentAccountLedgerEntry": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/payment-account/ledger-entries/{ledger_entry_id}",
      "risk": "R",
      "description": "Get a single Shop Payment Account Ledger's Entry Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopPaymentAccountLedgerEntry",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "ledger_entry_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique ID of the shop owner ledger entry.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "ledger_entry_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "ledger_entry_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/PaymentAccountLedgerEntry"
        }
      },
      "response_definitions": [
        "PaymentAccountLedgerEntry",
        "PaymentAdjustment",
        "PaymentAdjustmentItem"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "getShopPaymentAccountLedgerEntries": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/payment-account/ledger-entries",
      "risk": "R",
      "description": "Get a Shop Payment Account Ledger's Entries Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopPaymentAccountLedgerEntries",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "min_created": {
                "type": "integer",
                "minimum": 946684800,
                "description": "The earliest unix timestamp for when a record was created.",
                "maximum": 9007199254740991
              },
              "max_created": {
                "type": "integer",
                "minimum": 946684800,
                "description": "The latest unix timestamp for when a record was created.",
                "maximum": 9007199254740991
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "min_created",
              "max_created"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "min_created"
        },
        {
          "location": "query",
          "name": "max_created"
        },
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/PaymentAccountLedgerEntries"
        }
      },
      "response_definitions": [
        "PaymentAccountLedgerEntries",
        "PaymentAccountLedgerEntry",
        "PaymentAdjustment",
        "PaymentAdjustmentItem"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "getPaymentAccountLedgerEntryPayments": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/payment-account/ledger-entries/payments",
      "risk": "R",
      "description": "Get a Payment from a PaymentAccount Ledger Entry ID, if applicable Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getPaymentAccountLedgerEntryPayments",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "ledger_entry_ids": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              }
            },
            "required": [
              "ledger_entry_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "ledger_entry_ids"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/Payments"
        }
      },
      "response_definitions": [
        "Payments",
        "Payment",
        "Money",
        "PaymentAdjustment",
        "PaymentAdjustmentItem"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "getShopPaymentByReceiptId": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/receipts/{receipt_id}/payments",
      "risk": "R",
      "description": "Retrieves a payment from a specific receipt, identified by `receipt_id`, from a specific shop, identified by `shop_id` Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopPaymentByReceiptId",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "receipt_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [receipt](/documentation/reference#tag/Shop-Receipt) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "receipt_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "receipt_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/Payments"
        }
      },
      "response_definitions": [
        "Payments",
        "Payment",
        "Money",
        "PaymentAdjustment",
        "PaymentAdjustmentItem"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "getPayments": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/payments",
      "risk": "R",
      "description": "Retrieves a list of payments from a shop identified by `shop_id`. You can also filter results using a list of payment IDs. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getPayments",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "payment_ids": {
                "type": "array",
                "description": "A comma-separated array of Payment IDs numbers.",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              }
            },
            "required": [
              "payment_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "payment_ids"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/Payments"
        }
      },
      "response_definitions": [
        "Payments",
        "Payment",
        "Money",
        "PaymentAdjustment",
        "PaymentAdjustmentItem"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "getShopReceipt": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/receipts/{receipt_id}",
      "risk": "R",
      "description": "Retrieves a receipt, identified by a receipt id, from an Etsy shop. **NOTE** Access to ShopReceipt's first_line, second_line, city, state, zip, country_iso and formatted_address is Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopReceipt",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "receipt_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [receipt](/documentation/reference#tag/Shop-Receipt) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "receipt_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "legacy": {
                "type": "boolean",
                "description": "This parameter needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "receipt_id"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReceipt"
        }
      },
      "response_definitions": [
        "ShopReceipt",
        "Money",
        "ShopReceiptShipment",
        "ShopReceiptTransaction",
        "TransactionVariations",
        "ListingPropertyValue",
        "ShopRefund"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "updateShopReceipt": {
      "method": "PUT",
      "path": "/v3/application/shops/{shop_id}/receipts/{receipt_id}",
      "risk": "H",
      "description": "Updates the status of a receipt, identified by a receipt id, from an Etsy shop. **NOTE** Access to ShopReceipt's first_line, second_line, city, state, zip, country_iso and formatte Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateShopReceipt",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "receipt_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [receipt](/documentation/reference#tag/Shop-Receipt) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "receipt_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "legacy": {
                "type": "boolean",
                "description": "This parameter needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "was_shipped": {
                "anyOf": [
                  {
                    "type": "boolean",
                    "description": "When `true`, returns receipts where the seller shipped the product(s) in this receipt. When `false`, returns receipts where shipment has not been set."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "was_paid": {
                "anyOf": [
                  {
                    "type": "boolean",
                    "description": "When `true`, returns receipts where the seller has received payment for the receipt. When `false`, returns receipts where payment has not been received."
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "receipt_id"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReceipt"
        }
      },
      "response_definitions": [
        "ShopReceipt",
        "Money",
        "ShopReceiptShipment",
        "ShopReceiptTransaction",
        "TransactionVariations",
        "ListingPropertyValue",
        "ShopRefund"
      ],
      "scopes": [
        "transactions_w"
      ]
    },
    "getShopReceipts": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/receipts",
      "risk": "R",
      "description": "Requests the Shop Receipts from a specific Shop, unfiltered or filtered by receipt id range or offset, date, paid, and/or shipped purchases. **NOTE** Access to ShopReceipt's first_ Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopReceipts",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "min_created": {
                "type": "integer",
                "minimum": 946684800,
                "description": "The earliest unix timestamp for when a record was created.",
                "maximum": 9007199254740991
              },
              "max_created": {
                "type": "integer",
                "minimum": 946684800,
                "description": "The latest unix timestamp for when a record was created.",
                "maximum": 9007199254740991
              },
              "min_last_modified": {
                "type": "integer",
                "minimum": 946684800,
                "description": "The earliest unix timestamp for when a record last changed.",
                "maximum": 9007199254740991
              },
              "max_last_modified": {
                "type": "integer",
                "minimum": 946684800,
                "description": "The latest unix timestamp for when a record last changed.",
                "maximum": 9007199254740991
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              },
              "sort_on": {
                "type": "string",
                "enum": [
                  "created",
                  "updated",
                  "receipt_id"
                ],
                "description": "The value to sort a search result of listings on.",
                "maxLength": 262144
              },
              "sort_order": {
                "type": "string",
                "enum": [
                  "asc",
                  "ascending",
                  "desc",
                  "descending",
                  "up",
                  "down"
                ],
                "description": "The ascending(up) or descending(down) order to sort receipts by.",
                "maxLength": 262144
              },
              "was_paid": {
                "anyOf": [
                  {
                    "type": "boolean",
                    "description": "When `true`, returns receipts where the seller has received payment for the receipt. When `false`, returns receipts where payment has not been received."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "was_shipped": {
                "anyOf": [
                  {
                    "type": "boolean",
                    "description": "When `true`, returns receipts where the seller shipped the product(s) in this receipt. When `false`, returns receipts where shipment has not been set."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "was_delivered": {
                "anyOf": [
                  {
                    "type": "boolean",
                    "description": "When `true`, returns receipts that have been marked as delivered. When `false`, returns receipts where shipment has not been marked as delivered."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "was_canceled": {
                "anyOf": [
                  {
                    "type": "boolean",
                    "description": "When `true`, the endpoint will only return the canceled receipts. When `false`, the endpoint will only return non-canceled receipts."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "legacy": {
                "type": "boolean",
                "description": "This parameter needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "min_created"
        },
        {
          "location": "query",
          "name": "max_created"
        },
        {
          "location": "query",
          "name": "min_last_modified"
        },
        {
          "location": "query",
          "name": "max_last_modified"
        },
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        },
        {
          "location": "query",
          "name": "sort_on"
        },
        {
          "location": "query",
          "name": "sort_order"
        },
        {
          "location": "query",
          "name": "was_paid"
        },
        {
          "location": "query",
          "name": "was_shipped"
        },
        {
          "location": "query",
          "name": "was_delivered"
        },
        {
          "location": "query",
          "name": "was_canceled"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReceipts"
        }
      },
      "response_definitions": [
        "ShopReceipts",
        "ShopReceipt",
        "Money",
        "ShopReceiptShipment",
        "ShopReceiptTransaction",
        "TransactionVariations",
        "ListingPropertyValue",
        "ShopRefund"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "getListingsByShopReceipt": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/receipts/{receipt_id}/listings",
      "risk": "R",
      "description": "Gets all listings associated with a receipt. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingsByShopReceipt",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "receipt_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [receipt](/documentation/reference#tag/Shop-Receipt) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "receipt_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              },
              "legacy": {
                "type": "boolean",
                "description": "This parameter is needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "receipt_id"
        },
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListings"
        }
      },
      "response_definitions": [
        "ShopListings",
        "ShopListing",
        "Money"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "createReceiptShipment": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/receipts/{receipt_id}/tracking",
      "risk": "H",
      "description": "Submits tracking information for a Shop Receipt, which creates a Shop Receipt Shipment entry for the given receipt_id. Each time you successfully submit tracking info, Etsy sends a Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/createReceiptShipment",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "receipt_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The receipt to submit tracking for.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "receipt_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "legacy": {
                "type": "boolean",
                "description": "This parameter needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "tracking_code": {
                "type": "string",
                "description": "The tracking code for this receipt.",
                "maxLength": 262144
              },
              "carrier_name": {
                "type": "string",
                "description": "The carrier name for this receipt.",
                "maxLength": 262144
              },
              "send_bcc": {
                "type": "boolean",
                "description": "If true, the shipping notification will be sent to the seller as well"
              },
              "note_to_buyer": {
                "type": "string",
                "description": "Message to include in notification to the buyer.",
                "maxLength": 262144
              },
              "mail_class": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "The service level of postal or carrier service selected for the shipment (e.g., First-Class, Priority, Ground, Express).",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "weight": {
                "anyOf": [
                  {
                    "type": "number",
                    "description": "The total weight of the package."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "weight_units": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Unit of measurement used for package weight (oz, grams, etc.).",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "length": {
                "anyOf": [
                  {
                    "type": "number",
                    "description": "Longest side of the package."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "width": {
                "anyOf": [
                  {
                    "type": "number",
                    "description": "Second longest side of the package."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "height": {
                "anyOf": [
                  {
                    "type": "number",
                    "description": "Third longest side of the package."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "dimension_units": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Unit of measurement used for package dimensions (in, cm...).",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "shipping_label_cost": {
                "anyOf": [
                  {
                    "type": "number",
                    "description": "The purchase price the seller paid for the shipping label."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "shipping_label_currency": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "The currency in which the shipping label was purchased.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "revenue_eligibility": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "A flag indicating if the shipment is tied to a revenue share agreement between Etsy and the vendor.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ship_from_country": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Where the package ships from.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ship_to_country": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Package destination.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "incoterm": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "The specific incoterm (e.g., DDU, DDP) designated for the shipment.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "customs_data": {
                "anyOf": [
                  {
                    "type": "array",
                    "description": "Contains custom data like country of origin, declared value and HS code.",
                    "items": {
                      "type": "object",
                      "required": [
                        "country_of_origin",
                        "declared_value",
                        "HS_code"
                      ],
                      "properties": {
                        "country_of_origin": {
                          "anyOf": [
                            {
                              "type": "string",
                              "description": "The country in which the goods originate from.",
                              "maxLength": 262144
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "declared_value": {
                          "anyOf": [
                            {
                              "type": "number",
                              "description": "The commercial value of the goods."
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "HS_code": {
                          "anyOf": [
                            {
                              "type": "string",
                              "description": "The standardized global system (Harmonized System) for classifying traded products.",
                              "maxLength": 262144
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "additionalProperties": false
                    },
                    "maxItems": 10
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "duty_amount": {
                "anyOf": [
                  {
                    "type": "number",
                    "description": "The estimated or actual amount of import duties and taxes assessed by customs for the shipment."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "duty_currency": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "The currency in which the duty was paid.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "ship_date": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "The date package was shipped.",
                    "maxLength": 262144
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "receipt_id"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/json",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReceipt"
        }
      },
      "response_definitions": [
        "ShopReceipt",
        "Money",
        "ShopReceiptShipment",
        "ShopReceiptTransaction",
        "TransactionVariations",
        "ListingPropertyValue",
        "ShopRefund"
      ],
      "scopes": [
        "transactions_w"
      ]
    },
    "getShopReceiptTransactionsByReceipt": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/receipts/{receipt_id}/transactions",
      "risk": "R",
      "description": "Retrieves the list of transactions associated with a specific receipt. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopReceiptTransactionsByReceipt",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "receipt_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [receipt](/documentation/reference#tag/Shop-Receipt) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "receipt_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "legacy": {
                "type": "boolean",
                "description": "This parameter needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "receipt_id"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReceiptTransactions"
        }
      },
      "response_definitions": [
        "ShopReceiptTransactions",
        "ShopReceiptTransaction",
        "Money",
        "TransactionVariations",
        "ListingPropertyValue"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "getReviewsByListing": {
      "method": "GET",
      "path": "/v3/application/listings/{listing_id}/reviews",
      "risk": "R",
      "description": "Open API V3 to retrieve the reviews for a listing given its ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getReviewsByListing",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listing_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID for the [listing](/documentation/reference#tag/ShopListing) associated to this transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "listing_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              },
              "min_created": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 946684800,
                    "description": "The earliest unix timestamp for when a record was created.",
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "max_created": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 946684800,
                    "description": "The latest unix timestamp for when a record was created.",
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "listing_id"
        },
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        },
        {
          "location": "query",
          "name": "min_created"
        },
        {
          "location": "query",
          "name": "max_created"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListingReviews"
        }
      },
      "response_definitions": [
        "ListingReviews",
        "ListingReview"
      ],
      "scopes": []
    },
    "getReviewsByShop": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/reviews",
      "risk": "R",
      "description": "Open API V3 to retrieve the reviews from a shop given its ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getReviewsByShop",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              },
              "min_created": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 946684800,
                    "description": "The earliest unix timestamp for when a record was created.",
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "max_created": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 946684800,
                    "description": "The latest unix timestamp for when a record was created.",
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        },
        {
          "location": "query",
          "name": "min_created"
        },
        {
          "location": "query",
          "name": "max_created"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/TransactionReviews"
        }
      },
      "response_definitions": [
        "TransactionReviews",
        "TransactionReview"
      ],
      "scopes": []
    },
    "getSellerTaxonomyNodes": {
      "method": "GET",
      "path": "/v3/application/seller-taxonomy/nodes",
      "risk": "R",
      "description": "Retrieves the full hierarchy tree of seller taxonomy nodes. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getSellerTaxonomyNodes",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/SellerTaxonomyNodes"
        }
      },
      "response_definitions": [
        "SellerTaxonomyNodes",
        "SellerTaxonomyNode"
      ],
      "scopes": []
    },
    "getPropertiesByTaxonomyId": {
      "method": "GET",
      "path": "/v3/application/seller-taxonomy/nodes/{taxonomy_id}/properties",
      "risk": "R",
      "description": "Retrieves a list of product properties, with applicable scales and values, supported for a specific seller taxonomy ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getPropertiesByTaxonomyId",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "taxonomy_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique numeric ID of an Etsy taxonomy node, which is a metadata category for listings organized into the seller taxonomy hierarchy tree. For example, the \"shoes\" taxonomy node (ID: 1429, level: 1) is higher in the hierarchy than \"girls' shoes\" (ID: 1440, level: 2). The taxonomy nodes assigned to a listing support access to specific standardized product scales and properties. For example, listings assigned the taxonomy nodes \"shoes\" or \"girls' shoes\" support access to the \"EU\" shoe size scale with its associated property names and IDs for EU shoe sizes, such as property `value_id`:\"1394\", and `name`:\"38\".",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "taxonomy_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "supports_variations": {
                "anyOf": [
                  {
                    "type": "boolean",
                    "description": "When `true`, returns properties that support variations. When `false`, returns properties that do not support variations."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "supports_attributes": {
                "anyOf": [
                  {
                    "type": "boolean",
                    "description": "When `true`, returns properties that support attributes. When `false`, returns properties that do not support attributes."
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "taxonomy_id"
        },
        {
          "location": "query",
          "name": "supports_variations"
        },
        {
          "location": "query",
          "name": "supports_attributes"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/TaxonomyNodeProperties"
        }
      },
      "response_definitions": [
        "TaxonomyNodeProperties",
        "TaxonomyNodeProperty",
        "TaxonomyPropertyScale",
        "TaxonomyPropertyValue"
      ],
      "scopes": []
    },
    "getShippingCarriers": {
      "method": "GET",
      "path": "/v3/application/shipping-carriers",
      "risk": "R",
      "description": "Retrieves a list of available shipping carriers and the mail classes associated with them for a given country Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShippingCarriers",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "origin_country_iso": {
                "type": "string",
                "description": "The ISO code of the country from which the listing ships.",
                "maxLength": 262144
              }
            },
            "required": [
              "origin_country_iso"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "origin_country_iso"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShippingCarriers"
        }
      },
      "response_definitions": [
        "ShippingCarriers",
        "ShippingCarrier",
        "ShippingCarrierMailClass"
      ],
      "scopes": []
    },
    "getShop": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}",
      "risk": "R",
      "description": "Retrieves the shop identified by a specific shop ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShop",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/Shop"
        }
      },
      "response_definitions": [
        "Shop"
      ],
      "scopes": []
    },
    "updateShop": {
      "method": "PUT",
      "path": "/v3/application/shops/{shop_id}",
      "risk": "H",
      "description": "Updates a shop. Assumes that all string parameters are provided in the shop's primary language. Please note that the policy_additional field should only be set for shops located in Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateShop",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "description": "A brief heading string for the shop's main page.",
                "maxLength": 262144
              },
              "announcement": {
                "type": "string",
                "description": "An announcement string to buyers that displays on the shop's homepage.",
                "maxLength": 262144
              },
              "sale_message": {
                "type": "string",
                "description": "A message string sent to users who complete a purchase from this shop.",
                "maxLength": 262144
              },
              "digital_sale_message": {
                "type": "string",
                "description": "A message string sent to users who purchase a digital item from this shop.",
                "maxLength": 262144
              },
              "policy_additional": {
                "type": "string",
                "description": "The shop's additional policies string (may be blank).",
                "maxLength": 262144
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/Shop"
        }
      },
      "response_definitions": [
        "Shop"
      ],
      "scopes": [
        "shops_r",
        "shops_w"
      ]
    },
    "getShopByOwnerUserId": {
      "method": "GET",
      "path": "/v3/application/users/{user_id}/shops",
      "risk": "R",
      "description": "Retrieves the shop identified by the shop owner's user ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopByOwnerUserId",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "user_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/Shop"
        }
      },
      "response_definitions": [
        "Shop"
      ],
      "scopes": []
    },
    "getHolidayPreferences": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/holiday-preferences",
      "risk": "R",
      "description": "Retrieves a list of holidays that are available to a shop to set a preference for. Currently only supported in the US and CA Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getHolidayPreferences",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ShopHolidayPreference"
          }
        }
      },
      "response_definitions": [
        "ShopHolidayPreference"
      ],
      "scopes": [
        "shops_r"
      ]
    },
    "updateHolidayPreferences": {
      "method": "PUT",
      "path": "/v3/application/shops/{shop_id}/holiday-preferences/{holiday_id}",
      "risk": "H",
      "description": "Updates the preference for whether the seller will process orders or not on the holiday. Currently only supported in the US and CA Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateHolidayPreferences",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "holiday_id": {
                "type": "integer",
                "enum": [
                  1,
                  2,
                  3,
                  4,
                  5,
                  6,
                  7,
                  8,
                  9,
                  10,
                  11,
                  12,
                  13,
                  14,
                  15,
                  16,
                  17,
                  18,
                  19,
                  20,
                  21,
                  22,
                  23,
                  24,
                  25,
                  26,
                  27,
                  28,
                  29,
                  30,
                  31,
                  32,
                  33,
                  34,
                  35,
                  36,
                  37,
                  38,
                  39,
                  40,
                  41,
                  42,
                  43,
                  44,
                  45,
                  46,
                  47,
                  48,
                  49,
                  50,
                  51,
                  52,
                  53,
                  54,
                  55,
                  56,
                  57,
                  58,
                  59,
                  60,
                  61,
                  62,
                  63,
                  64,
                  65,
                  66,
                  67,
                  68,
                  69,
                  70,
                  71,
                  72,
                  73,
                  74,
                  75,
                  76,
                  77,
                  78,
                  79,
                  80,
                  81,
                  82,
                  83,
                  84,
                  85,
                  86,
                  87,
                  88,
                  89,
                  90,
                  91,
                  92,
                  93,
                  94,
                  95,
                  96,
                  97,
                  98,
                  99,
                  100,
                  101,
                  102,
                  103,
                  104,
                  105
                ],
                "description": "The unique id that maps to the holiday a country observes. See the [Fulfillment Tutorial docs](https://developer.etsy.com/documentation/tutorials/fulfillment/#country-holidays) for more info",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "holiday_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "required": [
              "is_working"
            ],
            "properties": {
              "is_working": {
                "type": "boolean",
                "description": "A boolean value for whether the shop will process orders on a particular holiday."
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "holiday_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopHolidayPreference"
        }
      },
      "response_definitions": [
        "ShopHolidayPreference"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "findShops": {
      "method": "GET",
      "path": "/v3/application/shops",
      "risk": "R",
      "description": "Open API V3 endpoint for searching shops by name. Note: We make every effort to ensure that frozen or removed shops are not included in the search results. However, rarely, due to  Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/findShops",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "shop_name": {
                "type": "string",
                "description": "The shop's name string.",
                "maxLength": 262144
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shop_name"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "shop_name"
        },
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        }
      ],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/Shops"
        }
      },
      "response_definitions": [
        "Shops",
        "Shop"
      ],
      "scopes": []
    },
    "consolidateShopReturnPolicies": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/policies/return/consolidate",
      "risk": "H",
      "description": "Consolidates Return Policies by moving all listings from a source return policy to a destination return policy, and deleting the source return policy. This is commonly used in the  Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/consolidateShopReturnPolicies",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "required": [
              "source_return_policy_id",
              "destination_return_policy_id"
            ],
            "properties": {
              "source_return_policy_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [Return Policy](/documentation/reference#operation/getShopReturnPolicies).",
                "maximum": 9007199254740991
              },
              "destination_return_policy_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [Return Policy](/documentation/reference#operation/getShopReturnPolicies).",
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReturnPolicy"
        }
      },
      "response_definitions": [
        "ShopReturnPolicy"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "createShopReturnPolicy": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/policies/return",
      "risk": "W",
      "description": "Creates a new Return Policy. Note: if either accepts_returns or accepts_exchanges is true, then a return_deadline is required. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/createShopReturnPolicy",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "required": [
              "accepts_returns",
              "accepts_exchanges"
            ],
            "properties": {
              "accepts_returns": {
                "type": "boolean"
              },
              "accepts_exchanges": {
                "type": "boolean"
              },
              "return_deadline": {
                "anyOf": [
                  {
                    "type": "integer",
                    "description": "The deadline for the Return Policy, measured in days. The value must be one of the following: [7, 14, 21, 30, 45, 60, 90].",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReturnPolicy"
        }
      },
      "response_definitions": [
        "ShopReturnPolicy"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "getShopReturnPolicies": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/policies/return",
      "risk": "R",
      "description": "Returns a shop's list of existing Return Policies Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopReturnPolicies",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReturnPolicies"
        }
      },
      "response_definitions": [
        "ShopReturnPolicies",
        "ShopReturnPolicy"
      ],
      "scopes": []
    },
    "deleteShopReturnPolicy": {
      "method": "DELETE",
      "path": "/v3/application/shops/{shop_id}/policies/return/{return_policy_id}",
      "risk": "D",
      "description": "Deletes an existing Return Policy. Deletion is only allowed for policies which have no associated listings – move them to another policy before attempting deletion. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteShopReturnPolicy",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "return_policy_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [Return Policy](/documentation/reference#operation/getShopReturnPolicies).",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "return_policy_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "return_policy_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "shops_w"
      ]
    },
    "getShopReturnPolicy": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/policies/return/{return_policy_id}",
      "risk": "R",
      "description": "Retrieves an existing Return Policy. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopReturnPolicy",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "return_policy_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [Return Policy](/documentation/reference#operation/getShopReturnPolicies).",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "return_policy_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "return_policy_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReturnPolicy"
        }
      },
      "response_definitions": [
        "ShopReturnPolicy"
      ],
      "scopes": []
    },
    "updateShopReturnPolicy": {
      "method": "PUT",
      "path": "/v3/application/shops/{shop_id}/policies/return/{return_policy_id}",
      "risk": "H",
      "description": "Updates an existing Return Policy. Note: if either accepts_returns or accepts_exchanges is true, then a return_deadline is required. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateShopReturnPolicy",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "return_policy_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [Return Policy](/documentation/reference#operation/getShopReturnPolicies).",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "return_policy_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "required": [
              "accepts_returns",
              "accepts_exchanges"
            ],
            "properties": {
              "accepts_returns": {
                "type": "boolean"
              },
              "accepts_exchanges": {
                "type": "boolean"
              },
              "return_deadline": {
                "anyOf": [
                  {
                    "type": "integer",
                    "description": "The deadline for the Return Policy, measured in days. The value must be one of the following: [7, 14, 21, 30, 45, 60, 90].",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "return_policy_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReturnPolicy"
        }
      },
      "response_definitions": [
        "ShopReturnPolicy"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "getListingsByShopReturnPolicy": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/policies/return/{return_policy_id}/listings",
      "risk": "R",
      "description": "Gets all listings associated with a Return Policy. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingsByShopReturnPolicy",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "return_policy_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [Return Policy](/documentation/reference#operation/getShopReturnPolicies).",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "return_policy_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "legacy": {
                "type": "boolean",
                "description": "This parameter is needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "return_policy_id"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListings"
        }
      },
      "response_definitions": [
        "ShopListings",
        "ShopListing",
        "Money"
      ],
      "scopes": [
        "listings_r"
      ]
    },
    "getShopProductionPartners": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/production-partners",
      "risk": "R",
      "description": "Retrieves a list of production partners available in the specific Etsy shop identified by its shop ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopProductionPartners",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopProductionPartners"
        }
      },
      "response_definitions": [
        "ShopProductionPartners",
        "ShopProductionPartner"
      ],
      "scopes": [
        "shops_r"
      ]
    },
    "createShopReadinessStateDefinition": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/readiness-state-definitions",
      "risk": "W",
      "description": "Creates a new ReadinessStateDefinition. If an existing definition matches the input values, this endpoint will throw a Conflict error, please refer to the Content-Location header t Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/createShopReadinessStateDefinition",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "required": [
              "readiness_state",
              "min_processing_time",
              "max_processing_time"
            ],
            "properties": {
              "readiness_state": {
                "type": "string",
                "enum": [
                  "ready_to_ship",
                  "made_to_order"
                ],
                "description": "The readiness state of a product: \\\"1\\\" means \\\"ready_to_ship\\\", and \\\"2\\\" means \\\"made_to_order\\\"",
                "maxLength": 262144
              },
              "min_processing_time": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "description": "The minimum number of days or weeks for processing a specific product."
              },
              "max_processing_time": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "description": "The maximum number of days or weeks for processing a specific product."
              },
              "processing_time_unit": {
                "type": "string",
                "enum": [
                  "days",
                  "weeks"
                ],
                "description": "The unit used to represent how long a processing time is. A week is equivalent to how many days the seller works per week as stated in their processing schedule. If none is provided, the unit is set to \\\"days\\\".",
                "maxLength": 262144
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ShopProcessingProfile"
        }
      },
      "response_definitions": [
        "ShopProcessingProfile"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "getShopReadinessStateDefinitions": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/readiness-state-definitions",
      "risk": "R",
      "description": "Retrieves a list of ProcessingProfiles available in the specific Etsy shop identified by its shop ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopReadinessStateDefinitions",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopProcessingProfiles"
        }
      },
      "response_definitions": [
        "ShopProcessingProfiles",
        "ShopProcessingProfile"
      ],
      "scopes": [
        "shops_r"
      ]
    },
    "deleteShopReadinessStateDefinition": {
      "method": "DELETE",
      "path": "/v3/application/shops/{shop_id}/readiness-state-definitions/{readiness_state_definition_id}",
      "risk": "D",
      "description": "Deletes a ReadinessStateDefinition by given readiness state definition ID. If there any active offerings linked to the definition, this endpoint will throw a Bad Request error. If  Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteShopReadinessStateDefinition",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "readiness_state_definition_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [processing profile](/documentation/reference#operation/getShopReadinessStateDefinition) associated with the listing. Returned only when the listing is `active` and of type `physical`, and the endpoint is either shop-scoped (path contains `shop_id`) or a single-listing request such as `getListing`. For every other case this field can be null.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "readiness_state_definition_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "readiness_state_definition_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "shops_w"
      ]
    },
    "getShopReadinessStateDefinition": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/readiness-state-definitions/{readiness_state_definition_id}",
      "risk": "R",
      "description": "Retrieves a ProcessingProfile referenced by readiness state definition ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopReadinessStateDefinition",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "readiness_state_definition_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [processing profile](/documentation/reference#operation/getShopReadinessStateDefinition) associated with the listing. Returned only when the listing is `active` and of type `physical`, and the endpoint is either shop-scoped (path contains `shop_id`) or a single-listing request such as `getListing`. For every other case this field can be null.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "readiness_state_definition_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "readiness_state_definition_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopProcessingProfile"
        }
      },
      "response_definitions": [
        "ShopProcessingProfile"
      ],
      "scopes": [
        "shops_r"
      ]
    },
    "updateShopReadinessStateDefinition": {
      "method": "PUT",
      "path": "/v3/application/shops/{shop_id}/readiness-state-definitions/{readiness_state_definition_id}",
      "risk": "H",
      "description": "Updates an existing ReadinessStateDefinition. If an existing definition matches the input values, this endpoint will throw a Conflict error, please refer to the Content-Location he Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateShopReadinessStateDefinition",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "readiness_state_definition_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [processing profile](/documentation/reference#operation/getShopReadinessStateDefinition) associated with the listing. Returned only when the listing is `active` and of type `physical`, and the endpoint is either shop-scoped (path contains `shop_id`) or a single-listing request such as `getListing`. For every other case this field can be null.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "readiness_state_definition_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "readiness_state": {
                "type": "string",
                "enum": [
                  "ready_to_ship",
                  "made_to_order"
                ],
                "description": "The readiness state of a product: \\\"1\\\" means \\\"ready_to_ship\\\", and \\\"2\\\" means \\\"made_to_order\\\"",
                "maxLength": 262144
              },
              "min_processing_time": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "description": "The minimum number of days or weeks for processing a specific product."
              },
              "max_processing_time": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "description": "The maximum number of days or weeks for processing a specific product."
              },
              "processing_time_unit": {
                "type": "string",
                "enum": [
                  "days",
                  "weeks"
                ],
                "description": "The unit used to represent how long a processing time is. A week is equivalent to how many days the seller works per week as stated in their processing schedule. If none is provided, the unit is set to \\\"days\\\".",
                "maxLength": 262144
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "readiness_state_definition_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopProcessingProfile"
        }
      },
      "response_definitions": [
        "ShopProcessingProfile"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "createShopSection": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/sections",
      "risk": "W",
      "description": "Creates a new section in a specific shop. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/createShopSection",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "required": [
              "title"
            ],
            "properties": {
              "title": {
                "type": "string",
                "description": "The title string for a shop section.",
                "maxLength": 262144
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopSection"
        }
      },
      "response_definitions": [
        "ShopSection"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "getShopSections": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/sections",
      "risk": "R",
      "description": "Retrieves the list of shop sections in a specific shop identified by shop ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopSections",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopSections"
        }
      },
      "response_definitions": [
        "ShopSections",
        "ShopSection"
      ],
      "scopes": []
    },
    "deleteShopSection": {
      "method": "DELETE",
      "path": "/v3/application/shops/{shop_id}/sections/{shop_section_id}",
      "risk": "D",
      "description": "Deletes a section in a specific shop given a valid shop_section_id. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteShopSection",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shop_section_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of a section in a specific Etsy shop.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shop_section_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shop_section_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "shops_w"
      ]
    },
    "getShopSection": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/sections/{shop_section_id}",
      "risk": "R",
      "description": "Retrieves a shop section, referenced by section ID and shop ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopSection",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shop_section_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of a section in a specific Etsy shop.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shop_section_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shop_section_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopSection"
        }
      },
      "response_definitions": [
        "ShopSection"
      ],
      "scopes": []
    },
    "updateShopSection": {
      "method": "PUT",
      "path": "/v3/application/shops/{shop_id}/sections/{shop_section_id}",
      "risk": "H",
      "description": "Updates a section in a specific shop given a valid shop_section_id. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateShopSection",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shop_section_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of a section in a specific Etsy shop.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shop_section_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "required": [
              "title"
            ],
            "properties": {
              "title": {
                "type": "string",
                "description": "The title string for a shop section.",
                "maxLength": 262144
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shop_section_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopSection"
        }
      },
      "response_definitions": [
        "ShopSection"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "getListingsByShopSectionId": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/shop-sections/listings",
      "risk": "R",
      "description": "Retrieves all the listings from the section of a specific shop. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getListingsByShopSectionId",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "shop_section_ids": {
                "type": "array",
                "description": "A list of numeric IDS for all sections in a specific Etsy shop.",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              },
              "sort_on": {
                "type": "string",
                "enum": [
                  "created",
                  "price",
                  "updated",
                  "score"
                ],
                "description": "The value to sort a search result of listings on. NOTES: a) `sort_on` only works when combined with one of the search options (keywords, region, etc.). b) when using `score` the returned results will always be in _descending_ order, regardless of the `sort_order` parameter.",
                "maxLength": 262144
              },
              "sort_order": {
                "type": "string",
                "enum": [
                  "asc",
                  "ascending",
                  "desc",
                  "descending",
                  "up",
                  "down"
                ],
                "description": "The ascending(up) or descending(down) order to sort listings by. NOTE: sort_order only works when combined with one of the search options (keywords, region, etc.).",
                "maxLength": 262144
              },
              "legacy": {
                "type": "boolean",
                "description": "This parameter is needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [
              "shop_section_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "shop_section_ids"
        },
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        },
        {
          "location": "query",
          "name": "sort_on"
        },
        {
          "location": "query",
          "name": "sort_order"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopListings"
        }
      },
      "response_definitions": [
        "ShopListings",
        "ShopListing",
        "Money"
      ],
      "scopes": []
    },
    "createShopShippingProfile": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles",
      "risk": "W",
      "description": "Creates a new ShippingProfile. You can pass a country iso code or a region when creating a ShippingProfile, but not both. Only one is required. You must pass either a shipping_carr Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/createShopShippingProfile",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "required": [
              "title",
              "origin_country_iso",
              "primary_cost",
              "secondary_cost"
            ],
            "properties": {
              "title": {
                "type": "string",
                "description": "The name string of this shipping profile.",
                "maxLength": 262144
              },
              "origin_country_iso": {
                "type": "string",
                "description": "The ISO code of the country from which the listing ships.",
                "maxLength": 262144
              },
              "primary_cost": {
                "type": "number",
                "minimum": 0,
                "description": "The cost of shipping to this country/region alone, measured in the store's default currency."
              },
              "secondary_cost": {
                "type": "number",
                "minimum": 0,
                "description": "The cost of shipping to this country/region with another item, measured in the store's default currency."
              },
              "min_processing_time": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "description": "The minimum time required to process to ship listings with this shipping profile."
              },
              "max_processing_time": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "description": "The maximum processing time the listing needs to ship."
              },
              "processing_time_unit": {
                "type": "string",
                "enum": [
                  "business_days",
                  "weeks"
                ],
                "description": "The unit used to represent how long a processing time is. A week is equivalent to the set processing schedule (default to 5 business days). If none is provided, the unit is set to \"business_days\".",
                "maxLength": 262144
              },
              "destination_country_iso": {
                "type": "string",
                "description": "The ISO code of the country to which the listing ships. If null, request sets destination to destination_region. Required if destination_region is null or not provided.",
                "maxLength": 262144
              },
              "destination_region": {
                "type": "string",
                "enum": [
                  "eu",
                  "non_eu",
                  "none"
                ],
                "description": "The code of the region to which the listing ships. A region represents a set of countries. Supported regions are Europe Union and Non-Europe Union (countries in Europe not in EU). If `none`, request sets destination to destination_country_iso. Required if destination_country_iso is null or not provided.",
                "maxLength": 262144
              },
              "origin_postal_code": {
                "type": "string",
                "description": "The postal code string (not necessarily a number) for the location from which the listing ships. Required if the `origin_country_iso` supports postal codes. See the [Fulfillment Tutorial docs](https://developer.etsy.com/documentation/tutorials/fulfillment/#countries-requiring-postal-codes) for more info",
                "maxLength": 262144
              },
              "shipping_carrier_id": {
                "type": "integer",
                "minimum": 0,
                "description": "The unique ID of a supported shipping carrier, which is used to calculate an Estimated Delivery Date. **Required with `mail_class`** if `min_delivery_days` and `max_delivery_days` are null.",
                "maximum": 9007199254740991
              },
              "mail_class": {
                "type": "string",
                "description": "The unique ID string of a shipping carrier's mail class, which is used to calculate an estimated delivery date. **Required with `shipping_carrier_id`** if `min_delivery_days` and `max_delivery_days` are null.",
                "maxLength": 262144
              },
              "min_delivery_days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 45,
                "description": "The minimum number of business days a buyer can expect to wait to receive their purchased item once it has shipped. **Required with `max_delivery_days`** if `mail_class` is null."
              },
              "max_delivery_days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 45,
                "description": "The maximum number of business days a buyer can expect to wait to receive their purchased item once it has shipped. **Required with `min_delivery_days`** if `mail_class` is null."
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopShippingProfile"
        }
      },
      "response_definitions": [
        "ShopShippingProfile",
        "ShopShippingProfileDestination",
        "Money",
        "ShopShippingProfileUpgrade"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "getShopShippingProfiles": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles",
      "risk": "R",
      "description": "Retrieves a list of shipping profiles available in the specific Etsy shop identified by its shop ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopShippingProfiles",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopShippingProfiles"
        }
      },
      "response_definitions": [
        "ShopShippingProfiles",
        "ShopShippingProfile",
        "ShopShippingProfileDestination",
        "Money",
        "ShopShippingProfileUpgrade"
      ],
      "scopes": [
        "shops_r"
      ]
    },
    "deleteShopShippingProfile": {
      "method": "DELETE",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}",
      "risk": "D",
      "description": "Deletes a ShippingProfile by given id. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteShopShippingProfile",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shipping_profile_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shipping_profile_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shipping_profile_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "shops_w"
      ]
    },
    "getShopShippingProfile": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}",
      "risk": "R",
      "description": "Retrieves a Shipping Profile referenced by shipping profile ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopShippingProfile",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shipping_profile_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shipping_profile_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shipping_profile_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopShippingProfile"
        }
      },
      "response_definitions": [
        "ShopShippingProfile",
        "ShopShippingProfileDestination",
        "Money",
        "ShopShippingProfileUpgrade"
      ],
      "scopes": [
        "shops_r"
      ]
    },
    "updateShopShippingProfile": {
      "method": "PUT",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}",
      "risk": "H",
      "description": "Changes the settings in a shipping profile. You can pass a country iso code or a region when updating a ShippingProfile, but not both. Only one is required. You must pass either a  Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateShopShippingProfile",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shipping_profile_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shipping_profile_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "description": "The name string of this shipping profile.",
                "maxLength": 262144
              },
              "origin_country_iso": {
                "type": "string",
                "description": "The ISO code of the country from which the listing ships.",
                "maxLength": 262144
              },
              "min_processing_time": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "description": "The minimum time required to process to ship listings with this shipping profile."
              },
              "max_processing_time": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "description": "The maximum processing time the listing needs to ship."
              },
              "processing_time_unit": {
                "type": "string",
                "enum": [
                  "business_days",
                  "weeks"
                ],
                "description": "The unit used to represent how long a processing time is. A week is equivalent to the set processing schedule (default to 5 business days). If none is provided, the unit is set to \"business_days\".",
                "maxLength": 262144
              },
              "origin_postal_code": {
                "type": "string",
                "description": "The postal code string (not necessarily a number) for the location from which the listing ships. Required if the `origin_country_iso` supports postal codes. See the [Fulfillment Tutorial docs](https://developer.etsy.com/documentation/tutorials/fulfillment/#countries-requiring-postal-codes) for more info",
                "maxLength": 262144
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shipping_profile_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopShippingProfile"
        }
      },
      "response_definitions": [
        "ShopShippingProfile",
        "ShopShippingProfileDestination",
        "Money",
        "ShopShippingProfileUpgrade"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "createShopShippingProfileDestination": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/destinations",
      "risk": "W",
      "description": "Creates a new shipping destination, which sets the shipping cost, carrier, and class for a destination in a [shipping profile](/documentation/reference/#tag/Shop-ShippingProfile).  Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/createShopShippingProfileDestination",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shipping_profile_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shipping_profile_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "required": [
              "primary_cost",
              "secondary_cost"
            ],
            "properties": {
              "primary_cost": {
                "type": "number",
                "minimum": 0,
                "description": "The cost of shipping to this country/region alone, measured in the store's default currency."
              },
              "secondary_cost": {
                "type": "number",
                "minimum": 0,
                "description": "The cost of shipping to this country/region with another item, measured in the store's default currency."
              },
              "destination_country_iso": {
                "type": "string",
                "description": "The ISO code of the country to which the listing ships. If null, request sets destination to destination_region. Required if destination_region is null or not provided.",
                "maxLength": 262144
              },
              "destination_region": {
                "type": "string",
                "enum": [
                  "eu",
                  "non_eu",
                  "none"
                ],
                "description": "The code of the region to which the listing ships. A region represents a set of countries. Supported regions are Europe Union and Non-Europe Union (countries in Europe not in EU). If `none`, request sets destination to destination_country_iso. Required if destination_country_iso is null or not provided.",
                "maxLength": 262144
              },
              "shipping_carrier_id": {
                "type": "integer",
                "minimum": 0,
                "description": "The unique ID of a supported shipping carrier, which is used to calculate an Estimated Delivery Date. **Required with `mail_class`** if `min_delivery_days` and `max_delivery_days` are null.",
                "maximum": 9007199254740991
              },
              "mail_class": {
                "type": "string",
                "description": "The unique ID string of a shipping carrier's mail class, which is used to calculate an estimated delivery date. **Required with `shipping_carrier_id`** if `min_delivery_days` and `max_delivery_days` are null.",
                "maxLength": 262144
              },
              "min_delivery_days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 45,
                "description": "The minimum number of business days a buyer can expect to wait to receive their purchased item once it has shipped. **Required with `max_delivery_days`** if `mail_class` is null."
              },
              "max_delivery_days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 45,
                "description": "The maximum number of business days a buyer can expect to wait to receive their purchased item once it has shipped. **Required with `min_delivery_days`** if `mail_class` is null."
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shipping_profile_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ShopShippingProfileDestination"
        }
      },
      "response_definitions": [
        "ShopShippingProfileDestination",
        "Money"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "getShopShippingProfileDestinationsByShippingProfile": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/destinations",
      "risk": "R",
      "description": "Retrieves a list of shipping destination objects associated with a shipping profile. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopShippingProfileDestinationsByShippingProfile",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shipping_profile_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shipping_profile_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shipping_profile_id"
        },
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopShippingProfileDestinations"
        }
      },
      "response_definitions": [
        "ShopShippingProfileDestinations",
        "ShopShippingProfileDestination",
        "Money"
      ],
      "scopes": [
        "shops_r"
      ]
    },
    "deleteShopShippingProfileDestination": {
      "method": "DELETE",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/destinations/{shipping_profile_destination_id}",
      "risk": "D",
      "description": "Deletes a shipping destination and removes the destination option from every listing that uses the associated shipping profile. A shipping profile requires at least one shipping de Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteShopShippingProfileDestination",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shipping_profile_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                "maximum": 9007199254740991
              },
              "shipping_profile_destination_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the shipping profile destination in the [shipping profile](/documentation/reference#tag/Shop-ShippingProfile) associated with the listing.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shipping_profile_id",
              "shipping_profile_destination_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shipping_profile_id"
        },
        {
          "location": "path",
          "name": "shipping_profile_destination_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "shops_w"
      ]
    },
    "updateShopShippingProfileDestination": {
      "method": "PUT",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/destinations/{shipping_profile_destination_id}",
      "risk": "H",
      "description": "Updates an existing shipping destination, which can set or reassign the shipping cost, carrier, and class for a destination. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateShopShippingProfileDestination",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shipping_profile_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                "maximum": 9007199254740991
              },
              "shipping_profile_destination_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the shipping profile destination in the [shipping profile](/documentation/reference#tag/Shop-ShippingProfile) associated with the listing.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shipping_profile_id",
              "shipping_profile_destination_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "primary_cost": {
                "type": "number",
                "minimum": 0,
                "description": "The cost of shipping to this country/region alone, measured in the store's default currency."
              },
              "secondary_cost": {
                "type": "number",
                "minimum": 0,
                "description": "The cost of shipping to this country/region with another item, measured in the store's default currency."
              },
              "destination_country_iso": {
                "type": "string",
                "description": "The ISO code of the country to which the listing ships. If null, request sets destination to destination_region. Required if destination_region is null or not provided.",
                "maxLength": 262144
              },
              "destination_region": {
                "type": "string",
                "enum": [
                  "eu",
                  "non_eu",
                  "none"
                ],
                "description": "The code of the region to which the listing ships. A region represents a set of countries. Supported regions are Europe Union and Non-Europe Union (countries in Europe not in EU). If `none`, request sets destination to destination_country_iso. Required if destination_country_iso is null or not provided.",
                "maxLength": 262144
              },
              "shipping_carrier_id": {
                "type": "integer",
                "minimum": 0,
                "description": "The unique ID of a supported shipping carrier, which is used to calculate an Estimated Delivery Date. **Required with `mail_class`** if `min_delivery_days` and `max_delivery_days` are null.",
                "maximum": 9007199254740991
              },
              "mail_class": {
                "type": "string",
                "description": "The unique ID string of a shipping carrier's mail class, which is used to calculate an estimated delivery date. **Required with `shipping_carrier_id`** if `min_delivery_days` and `max_delivery_days` are null.",
                "maxLength": 262144
              },
              "min_delivery_days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 45,
                "description": "The minimum number of business days a buyer can expect to wait to receive their purchased item once it has shipped. **Required with `max_delivery_days`** if `mail_class` is null."
              },
              "max_delivery_days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 45,
                "description": "The maximum number of business days a buyer can expect to wait to receive their purchased item once it has shipped. **Required with `min_delivery_days`** if `mail_class` is null."
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shipping_profile_id"
        },
        {
          "location": "path",
          "name": "shipping_profile_destination_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopShippingProfileDestination"
        }
      },
      "response_definitions": [
        "ShopShippingProfileDestination",
        "Money"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "createShopShippingProfileUpgrade": {
      "method": "POST",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/upgrades",
      "risk": "W",
      "description": "Creates a new shipping profile upgrade, which can establish a price for a shipping option, such as an alternate carrier or faster delivery. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/createShopShippingProfileUpgrade",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shipping_profile_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shipping_profile_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "required": [
              "type",
              "upgrade_name",
              "price",
              "secondary_price"
            ],
            "properties": {
              "type": {
                "type": "integer",
                "enum": [
                  0,
                  1
                ],
                "description": "The type of the shipping upgrade. Domestic (0) or international (1).",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "upgrade_name": {
                "type": "string",
                "description": "Name for the shipping upgrade shown to shoppers at checkout, e.g. USPS Priority.",
                "maxLength": 262144
              },
              "price": {
                "type": "number",
                "minimum": 0,
                "description": "Additional cost of adding the shipping upgrade."
              },
              "secondary_price": {
                "type": "number",
                "minimum": 0,
                "description": "Additional cost of adding the shipping upgrade for each additional item."
              },
              "shipping_carrier_id": {
                "type": "integer",
                "minimum": 0,
                "description": "The unique ID of a supported shipping carrier, which is used to calculate an Estimated Delivery Date. **Required with `mail_class`** if `min_delivery_days` and `max_delivery_days` are null.",
                "maximum": 9007199254740991
              },
              "mail_class": {
                "type": "string",
                "description": "The unique ID string of a shipping carrier's mail class, which is used to calculate an estimated delivery date. **Required with `shipping_carrier_id`** if `min_delivery_days` and `max_delivery_days` are null.",
                "maxLength": 262144
              },
              "min_delivery_days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 45,
                "description": "The minimum number of business days a buyer can expect to wait to receive their purchased item once it has shipped. **Required with `max_delivery_days`** if `mail_class` is null."
              },
              "max_delivery_days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 45,
                "description": "The maximum number of business days a buyer can expect to wait to receive their purchased item once it has shipped. **Required with `min_delivery_days`** if `mail_class` is null."
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shipping_profile_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopShippingProfileUpgrade"
        }
      },
      "response_definitions": [
        "ShopShippingProfileUpgrade",
        "Money"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "getShopShippingProfileUpgrades": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/upgrades",
      "risk": "R",
      "description": "Retrieves the list of shipping profile upgrades assigned to a specific shipping profile. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopShippingProfileUpgrades",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shipping_profile_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shipping_profile_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shipping_profile_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopShippingProfileUpgrades"
        }
      },
      "response_definitions": [
        "ShopShippingProfileUpgrades",
        "ShopShippingProfileUpgrade",
        "Money"
      ],
      "scopes": [
        "shops_r"
      ]
    },
    "deleteShopShippingProfileUpgrade": {
      "method": "DELETE",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/upgrades/{upgrade_id}",
      "risk": "D",
      "description": "Deletes a shipping profile upgrade and removes the upgrade option from every listing that uses the associated shipping profile. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/deleteShopShippingProfileUpgrade",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shipping_profile_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the shipping profile.",
                "maximum": 9007199254740991
              },
              "upgrade_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID that is associated with a shipping upgrade",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shipping_profile_id",
              "upgrade_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shipping_profile_id"
        },
        {
          "location": "path",
          "name": "upgrade_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "204": null
      },
      "response_definitions": [],
      "scopes": [
        "shops_w"
      ]
    },
    "updateShopShippingProfileUpgrade": {
      "method": "PUT",
      "path": "/v3/application/shops/{shop_id}/shipping-profiles/{shipping_profile_id}/upgrades/{upgrade_id}",
      "risk": "H",
      "description": "Updates a shipping profile upgrade and updates any listings that use the shipping profile. Acknowledgement only; inspect state before retrying uncertain writes. https://developers.etsy.com/documentation/reference/#operation/updateShopShippingProfileUpgrade",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shipping_profile_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID of the [shipping profile](/documentation/reference#operation/getShopShippingProfile) associated with the listing. Required when listing type is `physical`.",
                "maximum": 9007199254740991
              },
              "upgrade_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The numeric ID that is associated with a shipping upgrade",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "shipping_profile_id",
              "upgrade_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "upgrade_name": {
                "type": "string",
                "description": "Name for the shipping upgrade shown to shoppers at checkout, e.g. USPS Priority.",
                "maxLength": 262144
              },
              "type": {
                "type": "integer",
                "enum": [
                  0,
                  1
                ],
                "description": "The type of the shipping upgrade. Domestic (0) or international (1).",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "price": {
                "type": "number",
                "minimum": 0,
                "description": "Additional cost of adding the shipping upgrade."
              },
              "secondary_price": {
                "type": "number",
                "minimum": 0,
                "description": "Additional cost of adding the shipping upgrade for each additional item."
              },
              "shipping_carrier_id": {
                "type": "integer",
                "minimum": 0,
                "description": "The unique ID of a supported shipping carrier, which is used to calculate an Estimated Delivery Date. **Required with `mail_class`** if `min_delivery_days` and `max_delivery_days` are null.",
                "maximum": 9007199254740991
              },
              "mail_class": {
                "type": "string",
                "description": "The unique ID string of a shipping carrier's mail class, which is used to calculate an estimated delivery date. **Required with `shipping_carrier_id`** if `min_delivery_days` and `max_delivery_days` are null.",
                "maxLength": 262144
              },
              "min_delivery_days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 45,
                "description": "The minimum number of business days a buyer can expect to wait to receive their purchased item once it has shipped. **Required with `max_delivery_days`** if `mail_class` is null."
              },
              "max_delivery_days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 45,
                "description": "The maximum number of business days a buyer can expect to wait to receive their purchased item once it has shipped. **Required with `min_delivery_days`** if `mail_class` is null."
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "shipping_profile_id"
        },
        {
          "location": "path",
          "name": "upgrade_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": "application/x-www-form-urlencoded",
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopShippingProfileUpgrade"
        }
      },
      "response_definitions": [
        "ShopShippingProfileUpgrade",
        "Money"
      ],
      "scopes": [
        "shops_w"
      ]
    },
    "getShopReceiptTransaction": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/transactions/{transaction_id}",
      "risk": "R",
      "description": "Retrieves a transaction by transaction ID. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopReceiptTransaction",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "transaction_id": {
                "type": "integer",
                "minimum": 1,
                "description": "The unique numeric ID for a transaction.",
                "maximum": 9007199254740991
              }
            },
            "required": [
              "transaction_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "transaction_id"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReceiptTransaction"
        }
      },
      "response_definitions": [
        "ShopReceiptTransaction",
        "Money",
        "TransactionVariations",
        "ListingPropertyValue"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "getShopReceiptTransactionsByShop": {
      "method": "GET",
      "path": "/v3/application/shops/{shop_id}/transactions",
      "risk": "R",
      "description": "Retrieves the list of transactions associated with a shop. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getShopReceiptTransactionsByShop",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "The maximum number of results to return."
              },
              "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "The number of records to skip before selecting the first result.",
                "maximum": 9007199254740991
              },
              "legacy": {
                "type": "boolean",
                "description": "This parameter needed to enable new parameters and response values related to processing profiles."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "query",
          "name": "limit"
        },
        {
          "location": "query",
          "name": "offset"
        },
        {
          "location": "query",
          "name": "legacy"
        }
      ],
      "bindings": [
        "shop_id"
      ],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ShopReceiptTransactions"
        }
      },
      "response_definitions": [
        "ShopReceiptTransactions",
        "ShopReceiptTransaction",
        "Money",
        "TransactionVariations",
        "ListingPropertyValue"
      ],
      "scopes": [
        "transactions_r"
      ]
    },
    "getMe": {
      "method": "GET",
      "path": "/v3/application/users/me",
      "risk": "R",
      "description": "Returns basic info for the user making the request. Returns one page; retain pagination. https://developers.etsy.com/documentation/reference/#operation/getMe",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "bindings": [],
      "media": null,
      "binary": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/Self"
        }
      },
      "response_definitions": [
        "Self"
      ],
      "scopes": [
        "shops_r"
      ]
    }
  },
  "definitions": {
    "R": {},
    "W": {},
    "H": {},
    "D": {},
    "output": {
      "BuyerTaxonomyNodes": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/BuyerTaxonomyNode"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "BuyerTaxonomyNode": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer"
          },
          "level": {
            "type": "integer"
          },
          "name": {
            "type": "string"
          },
          "parent_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "children": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/BuyerTaxonomyNode"
                }
              ]
            }
          },
          "full_path_taxonomy_ids": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          }
        },
        "additionalProperties": true
      },
      "BuyerTaxonomyNodeProperties": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/BuyerTaxonomyNodeProperty"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "BuyerTaxonomyNodeProperty": {
        "type": "object",
        "properties": {
          "property_id": {
            "type": "integer"
          },
          "name": {
            "type": "string"
          },
          "display_name": {
            "type": "string"
          },
          "scales": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/BuyerTaxonomyPropertyScale"
                }
              ]
            }
          },
          "is_required": {
            "type": "boolean"
          },
          "supports_attributes": {
            "type": "boolean"
          },
          "supports_variations": {
            "type": "boolean"
          },
          "is_multivalued": {
            "type": "boolean"
          },
          "max_values_allowed": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "possible_values": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/BuyerTaxonomyPropertyValue"
                }
              ]
            }
          },
          "selected_values": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/BuyerTaxonomyPropertyValue"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "BuyerTaxonomyPropertyScale": {
        "type": "object",
        "properties": {
          "scale_id": {
            "type": "integer"
          },
          "display_name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "BuyerTaxonomyPropertyValue": {
        "type": "object",
        "properties": {
          "value_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "name": {
            "type": "string"
          },
          "scale_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "equal_to": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          }
        },
        "additionalProperties": true
      },
      "ShopListing": {
        "type": "object",
        "properties": {
          "listing_id": {
            "type": "integer"
          },
          "user_id": {
            "type": "integer"
          },
          "shop_id": {
            "type": "integer"
          },
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "creation_timestamp": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          },
          "ending_timestamp": {
            "type": "integer"
          },
          "original_creation_timestamp": {
            "type": "integer"
          },
          "last_modified_timestamp": {
            "type": "integer"
          },
          "updated_timestamp": {
            "type": "integer"
          },
          "state_timestamp": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "quantity": {
            "type": "integer"
          },
          "shop_section_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "featured_rank": {
            "type": "integer"
          },
          "url": {
            "type": "string"
          },
          "num_favorers": {
            "type": "integer"
          },
          "non_taxable": {
            "type": "boolean"
          },
          "is_taxable": {
            "type": "boolean"
          },
          "is_customizable": {
            "type": "boolean"
          },
          "is_personalizable": {
            "type": "boolean"
          },
          "listing_type": {
            "type": "string"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "materials": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "shipping_profile_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "return_policy_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "processing_min": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "processing_max": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "who_made": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "when_made": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "is_supply": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "item_weight": {
            "anyOf": [
              {
                "type": [
                  "number",
                  "string"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "item_weight_unit": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "item_length": {
            "anyOf": [
              {
                "type": [
                  "number",
                  "string"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "item_width": {
            "anyOf": [
              {
                "type": [
                  "number",
                  "string"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "item_height": {
            "anyOf": [
              {
                "type": [
                  "number",
                  "string"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "item_dimensions_unit": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "is_private": {
            "type": "boolean"
          },
          "style": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "file_data": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "has_variations": {
            "type": "boolean"
          },
          "should_auto_renew": {
            "type": "boolean"
          },
          "language": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "price": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "converted_price": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "taxonomy_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "readiness_state_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "suggested_title": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_garan_brand": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_garan_years": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_garan_model": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_garan_guarantee_details": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_other_commercial_guarantee_details": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_after_sales_service_info": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_software_update_details": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_commercial_guarantee_enabled": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "Money": {
        "type": "object",
        "properties": {
          "amount": {
            "type": "integer"
          },
          "divisor": {
            "type": "integer"
          },
          "currency_code": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ShopListingFile": {
        "type": "object",
        "properties": {
          "listing_file_id": {
            "type": "integer"
          },
          "listing_id": {
            "type": "integer"
          },
          "rank": {
            "type": "integer"
          },
          "filename": {
            "type": "string"
          },
          "filesize": {
            "type": "string"
          },
          "size_bytes": {
            "type": "integer"
          },
          "filetype": {
            "type": "string"
          },
          "create_timestamp": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "ShopListingFiles": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopListingFile"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ShopListings": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopListing"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ShopListingWithAssociations": {
        "type": "object",
        "properties": {
          "listing_id": {
            "type": "integer"
          },
          "user_id": {
            "type": "integer"
          },
          "shop_id": {
            "type": "integer"
          },
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "creation_timestamp": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          },
          "ending_timestamp": {
            "type": "integer"
          },
          "original_creation_timestamp": {
            "type": "integer"
          },
          "last_modified_timestamp": {
            "type": "integer"
          },
          "updated_timestamp": {
            "type": "integer"
          },
          "state_timestamp": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "quantity": {
            "type": "integer"
          },
          "shop_section_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "featured_rank": {
            "type": "integer"
          },
          "url": {
            "type": "string"
          },
          "num_favorers": {
            "type": "integer"
          },
          "non_taxable": {
            "type": "boolean"
          },
          "is_taxable": {
            "type": "boolean"
          },
          "is_customizable": {
            "type": "boolean"
          },
          "is_personalizable": {
            "type": "boolean"
          },
          "listing_type": {
            "type": "string"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "materials": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "shipping_profile_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "return_policy_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "processing_min": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "processing_max": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "who_made": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "when_made": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "is_supply": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "item_weight": {
            "anyOf": [
              {
                "type": [
                  "number",
                  "string"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "item_weight_unit": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "item_length": {
            "anyOf": [
              {
                "type": [
                  "number",
                  "string"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "item_width": {
            "anyOf": [
              {
                "type": [
                  "number",
                  "string"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "item_height": {
            "anyOf": [
              {
                "type": [
                  "number",
                  "string"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "item_dimensions_unit": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "is_private": {
            "type": "boolean"
          },
          "style": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "file_data": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "has_variations": {
            "type": "boolean"
          },
          "should_auto_renew": {
            "type": "boolean"
          },
          "language": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "price": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "converted_price": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "taxonomy_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "readiness_state_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "suggested_title": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_garan_brand": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_garan_years": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_garan_model": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_garan_guarantee_details": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_other_commercial_guarantee_details": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_after_sales_service_info": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_software_update_details": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ecgt_commercial_guarantee_enabled": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "shipping_profile": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ShopShippingProfile"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "user": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/User"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "shop": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Shop"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "images": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ListingImage"
                }
              ]
            }
          },
          "videos": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ListingVideo"
                }
              ]
            }
          },
          "inventory": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingInventory"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "production_partners": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopProductionPartner"
                }
              ]
            }
          },
          "skus": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "translations": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslations"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "views": {
            "type": "integer"
          },
          "personalization": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_ListingPersonalization"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "buyer_price": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingBuyerPrice"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ShopShippingProfile": {
        "type": "object",
        "properties": {
          "shipping_profile_id": {
            "type": "integer"
          },
          "title": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "user_id": {
            "type": "integer"
          },
          "origin_country_iso": {
            "type": "string"
          },
          "is_deleted": {
            "type": "boolean"
          },
          "shipping_profile_destinations": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopShippingProfileDestination"
                }
              ]
            }
          },
          "shipping_profile_upgrades": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopShippingProfileUpgrade"
                }
              ]
            }
          },
          "origin_postal_code": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "profile_type": {
            "type": "string"
          },
          "domestic_handling_fee": {
            "type": [
              "number",
              "string"
            ]
          },
          "international_handling_fee": {
            "type": [
              "number",
              "string"
            ]
          }
        },
        "additionalProperties": true
      },
      "ShopShippingProfileDestination": {
        "type": "object",
        "properties": {
          "shipping_profile_destination_id": {
            "type": "integer"
          },
          "shipping_profile_id": {
            "type": "integer"
          },
          "origin_country_iso": {
            "type": "string"
          },
          "destination_country_iso": {
            "type": "string"
          },
          "destination_region": {
            "type": "string"
          },
          "primary_cost": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "secondary_cost": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "shipping_carrier_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "mail_class": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "min_delivery_days": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "max_delivery_days": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ShopShippingProfileUpgrade": {
        "type": "object",
        "properties": {
          "shipping_profile_id": {
            "type": "integer"
          },
          "upgrade_id": {
            "type": "integer"
          },
          "upgrade_name": {
            "type": "string"
          },
          "type": {
            "type": "integer"
          },
          "rank": {
            "type": "integer"
          },
          "language": {
            "type": "string"
          },
          "price": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "secondary_price": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "shipping_carrier_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "mail_class": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "min_delivery_days": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "max_delivery_days": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "User": {
        "type": "object",
        "properties": {
          "user_id": {
            "type": "integer"
          },
          "primary_email": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "first_name": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "last_name": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "image_url_75x75": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "Shop": {
        "type": "object",
        "properties": {
          "shop_id": {
            "type": "integer"
          },
          "user_id": {
            "type": "integer"
          },
          "shop_name": {
            "type": "string"
          },
          "create_date": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          },
          "title": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "announcement": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "currency_code": {
            "type": "string"
          },
          "is_vacation": {
            "type": "boolean"
          },
          "vacation_message": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "sale_message": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "digital_sale_message": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "update_date": {
            "type": "integer"
          },
          "updated_timestamp": {
            "type": "integer"
          },
          "listing_active_count": {
            "type": "integer"
          },
          "digital_listing_count": {
            "type": "integer"
          },
          "login_name": {
            "type": "string"
          },
          "accepts_custom_requests": {
            "type": "boolean"
          },
          "policy_welcome": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "policy_payment": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "policy_shipping": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "policy_refunds": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "policy_additional": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "policy_seller_info": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "policy_update_date": {
            "type": "integer"
          },
          "policy_has_private_receipt_info": {
            "type": "boolean"
          },
          "has_unstructured_policies": {
            "type": "boolean"
          },
          "policy_privacy": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "vacation_autoreply": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "url": {
            "type": "string"
          },
          "image_url_760x100": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "num_favorers": {
            "type": "integer"
          },
          "languages": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "icon_url_fullxfull": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "is_using_structured_policies": {
            "type": "boolean"
          },
          "has_onboarded_structured_policies": {
            "type": "boolean"
          },
          "include_dispute_form_link": {
            "type": "boolean"
          },
          "is_direct_checkout_onboarded": {
            "type": "boolean"
          },
          "is_etsy_payments_onboarded": {
            "type": "boolean"
          },
          "is_calculated_eligible": {
            "type": "boolean"
          },
          "is_opted_in_to_buyer_promise": {
            "type": "boolean"
          },
          "is_shop_us_based": {
            "type": "boolean"
          },
          "transaction_sold_count": {
            "type": "integer"
          },
          "shipping_from_country_iso": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "shop_location_country_iso": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "review_count": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "review_average": {
            "anyOf": [
              {
                "type": [
                  "number",
                  "string"
                ]
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ListingImage": {
        "type": "object",
        "properties": {
          "listing_id": {
            "type": "integer"
          },
          "listing_image_id": {
            "type": "integer"
          },
          "hex_code": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "red": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "green": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "blue": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "hue": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "saturation": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "brightness": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "is_black_and_white": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "creation_tsz": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          },
          "rank": {
            "type": "integer"
          },
          "url_75x75": {
            "type": "string"
          },
          "url_170x135": {
            "type": "string"
          },
          "url_570xN": {
            "type": "string"
          },
          "url_fullxfull": {
            "type": "string"
          },
          "full_height": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "full_width": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "alt_text": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ListingVideo": {
        "type": "object",
        "properties": {
          "video_id": {
            "type": "integer"
          },
          "height": {
            "type": "integer"
          },
          "width": {
            "type": "integer"
          },
          "thumbnail_url": {
            "type": "string"
          },
          "video_url": {
            "type": "string"
          },
          "video_state": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ListingInventory": {
        "type": "object",
        "properties": {
          "products": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ListingInventoryProduct"
                }
              ]
            }
          },
          "price_on_property": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          },
          "quantity_on_property": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          },
          "sku_on_property": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          },
          "readiness_state_on_property": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          }
        },
        "additionalProperties": true
      },
      "ListingInventoryProduct": {
        "type": "object",
        "properties": {
          "product_id": {
            "type": "integer"
          },
          "sku": {
            "type": "string"
          },
          "is_deleted": {
            "type": "boolean"
          },
          "offerings": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ListingInventoryProductOffering"
                }
              ]
            }
          },
          "property_values": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ListingPropertyValue"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ListingInventoryProductOffering": {
        "type": "object",
        "properties": {
          "offering_id": {
            "type": "integer"
          },
          "quantity": {
            "type": "integer"
          },
          "is_enabled": {
            "type": "boolean"
          },
          "is_deleted": {
            "type": "boolean"
          },
          "price": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "readiness_state_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ListingPropertyValue": {
        "type": "object",
        "properties": {
          "property_id": {
            "type": "integer"
          },
          "property_name": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "scale_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "scale_name": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "value_ids": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          },
          "values": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "ShopProductionPartner": {
        "type": "object",
        "properties": {
          "production_partner_id": {
            "type": "integer"
          },
          "partner_name": {
            "type": "string"
          },
          "location": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ListingTranslations": {
        "type": "object",
        "properties": {
          "de": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "en-GB": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "en-IN": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "en-US": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "es": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "fr": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "it": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "ja": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "nl": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "pl": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "pt": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "ru": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "sv": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/ListingTranslation"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ListingTranslation": {
        "type": "object",
        "properties": {
          "listing_id": {
            "type": "integer"
          },
          "language": {
            "type": "string"
          },
          "title": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "description": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_ListingPersonalization": {
        "type": "object",
        "properties": {
          "personalization_questions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_PersonalizationQuestion"
            }
          }
        },
        "additionalProperties": true
      },
      "Etsy_Modules_ListingPersonalization_Api_Resources_OpenApi_PersonalizationQuestion": {
        "type": "object",
        "properties": {
          "question_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "question_text": {
            "type": "string"
          },
          "instructions": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "question_type": {
            "type": "string"
          },
          "required": {
            "type": "boolean"
          },
          "max_allowed_characters": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "max_allowed_files": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "add_on_price": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "options": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "option_id",
                    "label"
                  ],
                  "properties": {
                    "option_id": {
                      "anyOf": [
                        {
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "label": {
                      "type": "string"
                    }
                  },
                  "additionalProperties": true
                }
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ListingBuyerPrice": {
        "type": "object",
        "properties": {
          "base_price": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "shipping_cost": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "is_free_shipping": {
            "type": "boolean"
          },
          "original_price": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "discounted_price": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "discount_amount": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "discount_percentage": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "has_discount": {
            "type": "boolean"
          },
          "discount_start_epoch": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "discount_end_epoch": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ListingImages": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ListingImage"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ListingInventoryWithAssociations": {
        "type": "object",
        "properties": {
          "products": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ListingInventoryProduct"
                }
              ]
            }
          },
          "price_on_property": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          },
          "quantity_on_property": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          },
          "sku_on_property": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          },
          "readiness_state_on_property": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          },
          "listing": {
            "anyOf": [
              {
                "$ref": "#/$defs/ShopListing"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ShopListingsWithAssociations": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopListingWithAssociations"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ListingPropertyValues": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ListingPropertyValue"
            }
          }
        },
        "additionalProperties": true
      },
      "ShopReceiptTransactions": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopReceiptTransaction"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ShopReceiptTransaction": {
        "type": "object",
        "properties": {
          "transaction_id": {
            "type": "integer"
          },
          "title": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "description": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "seller_user_id": {
            "type": "integer"
          },
          "buyer_user_id": {
            "type": "integer"
          },
          "create_timestamp": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          },
          "paid_timestamp": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "shipped_timestamp": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "quantity": {
            "type": "integer"
          },
          "listing_image_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "receipt_id": {
            "type": "integer"
          },
          "is_digital": {
            "type": "boolean"
          },
          "file_data": {
            "type": "string"
          },
          "listing_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "transaction_type": {
            "type": "string"
          },
          "product_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "sku": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "price": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "shipping_cost": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "variations": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/TransactionVariations"
                }
              ]
            }
          },
          "product_data": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ListingPropertyValue"
                }
              ]
            }
          },
          "shipping_profile_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "min_processing_days": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "max_processing_days": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "shipping_method": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "shipping_upgrade": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "expected_ship_date": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "buyer_coupon": {
            "type": [
              "number",
              "string"
            ]
          },
          "shop_coupon": {
            "type": [
              "number",
              "string"
            ]
          }
        },
        "additionalProperties": true
      },
      "TransactionVariations": {
        "type": "object",
        "properties": {
          "property_id": {
            "type": "integer"
          },
          "value_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "formatted_name": {
            "type": "string"
          },
          "formatted_value": {
            "type": "string"
          },
          "question_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ListingVariationImages": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ListingVariationImage"
            }
          }
        },
        "additionalProperties": true
      },
      "ListingVariationImage": {
        "type": "object",
        "properties": {
          "property_id": {
            "type": "integer"
          },
          "value_id": {
            "type": "integer"
          },
          "value": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "image_id": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "ListingVideos": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ListingVideo"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "PaymentAccountLedgerEntry": {
        "type": "object",
        "properties": {
          "entry_id": {
            "type": "integer"
          },
          "ledger_id": {
            "type": "integer"
          },
          "sequence_number": {
            "type": "integer"
          },
          "amount": {
            "type": "integer"
          },
          "currency": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "balance": {
            "type": "integer"
          },
          "create_date": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          },
          "ledger_type": {
            "type": "string"
          },
          "reference_type": {
            "type": "string"
          },
          "reference_id": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "parent_entry_id": {
            "type": "integer"
          },
          "payment_adjustments": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/PaymentAdjustment"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "PaymentAdjustment": {
        "type": "object",
        "properties": {
          "payment_adjustment_id": {
            "type": "integer"
          },
          "payment_id": {
            "type": "integer"
          },
          "status": {
            "type": "string"
          },
          "is_success": {
            "type": "boolean"
          },
          "user_id": {
            "type": "integer"
          },
          "reason_code": {
            "type": "string"
          },
          "total_adjustment_amount": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "shop_total_adjustment_amount": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "buyer_total_adjustment_amount": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "total_fee_adjustment_amount": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "create_timestamp": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          },
          "update_timestamp": {
            "type": "integer"
          },
          "updated_timestamp": {
            "type": "integer"
          },
          "payment_adjustment_items": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/PaymentAdjustmentItem"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "PaymentAdjustmentItem": {
        "type": "object",
        "properties": {
          "payment_adjustment_id": {
            "type": "integer"
          },
          "payment_adjustment_item_id": {
            "type": "integer"
          },
          "adjustment_type": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "amount": {
            "type": "integer"
          },
          "shop_amount": {
            "type": "integer"
          },
          "transaction_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "bill_payment_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "created_timestamp": {
            "type": "integer"
          },
          "updated_timestamp": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "PaymentAccountLedgerEntries": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/PaymentAccountLedgerEntry"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "Payments": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/Payment"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "Payment": {
        "type": "object",
        "properties": {
          "payment_id": {
            "type": "integer"
          },
          "buyer_user_id": {
            "type": "integer"
          },
          "shop_id": {
            "type": "integer"
          },
          "receipt_id": {
            "type": "integer"
          },
          "amount_gross": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "amount_fees": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "amount_net": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "posted_gross": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "posted_fees": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "posted_net": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "adjusted_gross": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "adjusted_fees": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "adjusted_net": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "$ref": "#/$defs/Money"
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "currency": {
            "type": "string"
          },
          "shop_currency": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "buyer_currency": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "shipping_user_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "shipping_address_id": {
            "type": "integer"
          },
          "billing_address_id": {
            "type": "integer"
          },
          "status": {
            "type": "string"
          },
          "shipped_timestamp": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "create_timestamp": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          },
          "update_timestamp": {
            "type": "integer"
          },
          "updated_timestamp": {
            "type": "integer"
          },
          "payment_adjustments": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/PaymentAdjustment"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ShopReceipt": {
        "type": "object",
        "properties": {
          "receipt_id": {
            "type": "integer"
          },
          "receipt_type": {
            "type": "integer"
          },
          "seller_user_id": {
            "type": "integer"
          },
          "seller_email": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "buyer_user_id": {
            "type": "integer"
          },
          "buyer_email": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "name": {
            "type": "string"
          },
          "first_line": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "second_line": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "city": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "state": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "zip": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "status": {
            "type": "string"
          },
          "formatted_address": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "country_iso": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "payment_method": {
            "type": "string"
          },
          "payment_email": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "message_from_seller": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "message_from_buyer": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "message_from_payment": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "is_paid": {
            "type": "boolean"
          },
          "is_shipped": {
            "type": "boolean"
          },
          "create_timestamp": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          },
          "update_timestamp": {
            "type": "integer"
          },
          "updated_timestamp": {
            "type": "integer"
          },
          "is_gift": {
            "type": "boolean"
          },
          "gift_message": {
            "type": "string"
          },
          "gift_sender": {
            "type": "string"
          },
          "grandtotal": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "subtotal": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "total_price": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "total_shipping_cost": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "total_tax_cost": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "total_vat_cost": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "discount_amt": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "gift_wrap_price": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "shipments": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopReceiptShipment"
                }
              ]
            }
          },
          "transactions": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopReceiptTransaction"
                }
              ]
            }
          },
          "refunds": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopRefund"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ShopReceiptShipment": {
        "type": "object",
        "properties": {
          "receipt_shipping_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "shipment_notification_timestamp": {
            "type": "integer"
          },
          "carrier_name": {
            "type": "string"
          },
          "tracking_code": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ShopRefund": {
        "type": "object",
        "properties": {
          "amount": {
            "anyOf": [
              {
                "$ref": "#/$defs/Money"
              }
            ]
          },
          "created_timestamp": {
            "type": "integer"
          },
          "reason": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "note_from_issuer": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "status": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ShopReceipts": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopReceipt"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ListingReviews": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ListingReview"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ListingReview": {
        "type": "object",
        "properties": {
          "shop_id": {
            "type": "integer"
          },
          "listing_id": {
            "type": "integer"
          },
          "rating": {
            "type": "integer"
          },
          "review": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "language": {
            "type": "string"
          },
          "image_url_fullxfull": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "create_timestamp": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          },
          "update_timestamp": {
            "type": "integer"
          },
          "updated_timestamp": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "TransactionReviews": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/TransactionReview"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "TransactionReview": {
        "type": "object",
        "properties": {
          "shop_id": {
            "type": "integer"
          },
          "listing_id": {
            "type": "integer"
          },
          "transaction_id": {
            "type": "integer"
          },
          "buyer_user_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "rating": {
            "type": "integer"
          },
          "review": {
            "type": "string"
          },
          "language": {
            "type": "string"
          },
          "image_url_fullxfull": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "create_timestamp": {
            "type": "integer"
          },
          "created_timestamp": {
            "type": "integer"
          },
          "update_timestamp": {
            "type": "integer"
          },
          "updated_timestamp": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "SellerTaxonomyNodes": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/SellerTaxonomyNode"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "SellerTaxonomyNode": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer"
          },
          "level": {
            "type": "integer"
          },
          "name": {
            "type": "string"
          },
          "parent_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "children": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/SellerTaxonomyNode"
                }
              ]
            }
          },
          "full_path_taxonomy_ids": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          }
        },
        "additionalProperties": true
      },
      "TaxonomyNodeProperties": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/TaxonomyNodeProperty"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "TaxonomyNodeProperty": {
        "type": "object",
        "properties": {
          "property_id": {
            "type": "integer"
          },
          "name": {
            "type": "string"
          },
          "display_name": {
            "type": "string"
          },
          "scales": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/TaxonomyPropertyScale"
                }
              ]
            }
          },
          "is_required": {
            "type": "boolean"
          },
          "supports_attributes": {
            "type": "boolean"
          },
          "supports_variations": {
            "type": "boolean"
          },
          "is_multivalued": {
            "type": "boolean"
          },
          "max_values_allowed": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "possible_values": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/TaxonomyPropertyValue"
                }
              ]
            }
          },
          "selected_values": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/TaxonomyPropertyValue"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "TaxonomyPropertyScale": {
        "type": "object",
        "properties": {
          "scale_id": {
            "type": "integer"
          },
          "display_name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "TaxonomyPropertyValue": {
        "type": "object",
        "properties": {
          "value_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "name": {
            "type": "string"
          },
          "scale_id": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "equal_to": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          }
        },
        "additionalProperties": true
      },
      "ShippingCarriers": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ShippingCarrier"
            }
          }
        },
        "additionalProperties": true
      },
      "ShippingCarrier": {
        "type": "object",
        "properties": {
          "shipping_carrier_id": {
            "type": "integer"
          },
          "name": {
            "type": "string"
          },
          "domestic_classes": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShippingCarrierMailClass"
                }
              ]
            }
          },
          "international_classes": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShippingCarrierMailClass"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ShippingCarrierMailClass": {
        "type": "object",
        "properties": {
          "mail_class_key": {
            "type": "string"
          },
          "name": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ShopHolidayPreference": {
        "type": "object",
        "properties": {
          "shop_id": {
            "type": "integer"
          },
          "holiday_id": {
            "type": "integer"
          },
          "country_iso": {
            "type": "string"
          },
          "is_working": {
            "type": "boolean"
          },
          "holiday_name": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "Shops": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/Shop"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ShopReturnPolicy": {
        "type": "object",
        "properties": {
          "return_policy_id": {
            "type": "integer"
          },
          "shop_id": {
            "type": "integer"
          },
          "accepts_returns": {
            "type": "boolean"
          },
          "accepts_exchanges": {
            "type": "boolean"
          },
          "return_deadline": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "ShopReturnPolicies": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ShopReturnPolicy"
            }
          }
        },
        "additionalProperties": true
      },
      "ShopProductionPartners": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopProductionPartner"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ShopProcessingProfile": {
        "type": "object",
        "properties": {
          "shop_id": {
            "type": "integer"
          },
          "readiness_state_id": {
            "type": "integer"
          },
          "readiness_state": {
            "type": "string"
          },
          "min_processing_days": {
            "type": "integer"
          },
          "max_processing_days": {
            "type": "integer"
          },
          "processing_days_display_label": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ShopProcessingProfiles": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ShopProcessingProfile"
            }
          }
        },
        "additionalProperties": true
      },
      "ShopSection": {
        "type": "object",
        "properties": {
          "shop_section_id": {
            "type": "integer"
          },
          "title": {
            "type": "string"
          },
          "rank": {
            "type": "integer"
          },
          "user_id": {
            "type": "integer"
          },
          "active_listing_count": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "ShopSections": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopSection"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ShopShippingProfileDestinations": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopShippingProfileDestination"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "ShopShippingProfiles": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ShopShippingProfile"
            }
          }
        },
        "additionalProperties": true
      },
      "ShopShippingProfileUpgrades": {
        "type": "object",
        "properties": {
          "count": {
            "type": "integer"
          },
          "results": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/ShopShippingProfileUpgrade"
                }
              ]
            }
          }
        },
        "additionalProperties": true
      },
      "Self": {
        "type": "object",
        "properties": {
          "user_id": {
            "type": "integer"
          },
          "shop_id": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      }
    }
  },
  "excluded_methods": {
    "ping": "Connectivity health operation, owned by existing connector verification.",
    "tokenScopes": "Accepts caller OAuth tokens; authorization introspection is owned by existing grant flow.",
    "deleteUserAddress": "Requires address_r outside the current merchant OAuth grant.",
    "getUserAddress": "Requires address_r outside the current merchant OAuth grant.",
    "getUserAddresses": "Requires address_r outside the current merchant OAuth grant.",
    "getUser": "Requires email_r outside the current merchant OAuth grant."
  }
};
