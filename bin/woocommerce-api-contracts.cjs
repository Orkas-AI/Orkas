'use strict';
// Generated offline from pinned WooCommerce 11.1.2 controller contracts.
module.exports = {
  "release": "11.1.2",
  "release_commit": "2316335b1bce366178ce865d4e61a4c5e2219352",
  "methods": {
    "GET /products": {
      "method": "GET",
      "path": "/products",
      "risk": "R",
      "resource": "products",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "description": "Current page of the collection.",
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Maximum number of items to be returned in result set."
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "after": {
                "type": "string",
                "description": "Limit response to resources published after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "before": {
                "type": "string",
                "description": "Limit response to resources published before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "description": "Sort collection by object attribute.",
                "maxLength": 262144
              },
              "parent": {
                "type": "array",
                "description": "Limit result set to those of particular parent IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "parent_exclude": {
                "type": "array",
                "description": "Limit result set to all items except those of a particular parent ID.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "slug": {
                "type": "string",
                "description": "Limit result set to products with a specific slug.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "description": "Limit result set to products assigned a specific status.",
                "maxLength": 262144
              },
              "type": {
                "type": "string",
                "description": "Limit result set to products assigned a specific type.",
                "maxLength": 262144
              },
              "sku": {
                "type": "string",
                "description": "Limit result set to products with specific SKU(s). Use commas to separate.",
                "maxLength": 262144
              },
              "featured": {
                "type": "boolean",
                "description": "Limit result set to featured products."
              },
              "category": {
                "type": "string",
                "description": "Limit result set to products assigned a specific category ID.",
                "maxLength": 262144
              },
              "tag": {
                "type": "string",
                "description": "Limit result set to products assigned a specific tag ID.",
                "maxLength": 262144
              },
              "shipping_class": {
                "type": "string",
                "description": "Limit result set to products assigned a specific shipping class ID.",
                "maxLength": 262144
              },
              "attribute": {
                "type": "string",
                "description": "Limit result set to products with a specific attribute. Use the taxonomy name/attribute slug.",
                "maxLength": 262144
              },
              "attribute_term": {
                "type": "string",
                "description": "Limit result set to products with a specific attribute term ID (required an assigned attribute).",
                "maxLength": 262144
              },
              "tax_class": {
                "type": "string",
                "description": "Limit result set to products with a specific tax class.",
                "maxLength": 262144
              },
              "in_stock": {
                "type": "boolean",
                "description": "Limit result set to products in stock or out of stock."
              },
              "on_sale": {
                "type": "boolean",
                "description": "Limit result set to products on sale."
              },
              "min_price": {
                "type": "string",
                "description": "Limit result set to products based on a minimum price.",
                "maxLength": 262144
              },
              "max_price": {
                "type": "string",
                "description": "Limit result set to products based on a maximum price.",
                "maxLength": 262144
              },
              "image_size": {
                "type": "string",
                "description": "Image size to return. Accepts any registered WordPress image size.",
                "maxLength": 262144
              },
              "modified_after": {
                "type": "string",
                "description": "Limit response to resources modified after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "modified_before": {
                "type": "string",
                "description": "Limit response to resources modified before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "dates_are_gmt": {
                "type": "boolean",
                "description": "Whether to consider GMT post dates when limiting response by published or modified date."
              },
              "include_meta": {
                "type": "array",
                "description": "Limit meta_data to specific keys.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "exclude_meta": {
                "type": "array",
                "description": "Ensure meta_data excludes specific keys.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "stock_status": {
                "type": "string",
                "description": "Limit result set to products with specified stock status.",
                "maxLength": 262144
              },
              "search_sku": {
                "type": "string",
                "description": "Limit results to those with a SKU that partial matches a string. This argument takes precedence over 'sku'.",
                "maxLength": 262144
              },
              "search_name_or_sku": {
                "type": "string",
                "description": "Limit results to those with a name or SKU that partial matches a string. This argument takes precedence over 'search', 'sku' and 'search_sku'.",
                "maxLength": 262144
              },
              "search_fields": {
                "type": "array",
                "description": "Limit search to specific fields when used with search parameter. Available fields: name, sku, global_unique_id, description, short_description. This argument takes precedence over all other search parameters.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "include_status": {
                "type": "array",
                "description": "Limit result set to products with any of the statuses.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "exclude_status": {
                "type": "array",
                "description": "Exclude products with any of the statuses from result set.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "include_types": {
                "type": "array",
                "description": "Limit result set to products with any of the types.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "exclude_types": {
                "type": "array",
                "description": "Exclude products with any of the types from result set.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "downloadable": {
                "type": "boolean",
                "description": "Limit result set to downloadable products."
              },
              "virtual": {
                "type": "boolean",
                "description": "Limit result set to virtual products."
              },
              "pos_products_only": {
                "type": "boolean",
                "description": "Limit result set to products visible in Point of Sale."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /products — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /products": {
      "method": "POST",
      "path": "/products",
      "risk": "H",
      "resource": "products",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Product name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "Product slug.",
                "maxLength": 262144
              },
              "date_created": {
                "type": "string",
                "description": "The date the product was created, in the site's timezone.",
                "maxLength": 262144
              },
              "date_created_gmt": {
                "type": "string",
                "description": "The date the product was created, as GMT.",
                "maxLength": 262144
              },
              "type": {
                "type": "string",
                "description": "Product type.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "description": "Product status (post status).",
                "maxLength": 262144
              },
              "featured": {
                "type": "boolean",
                "description": "Featured product."
              },
              "catalog_visibility": {
                "type": "string",
                "description": "Catalog visibility.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "Product description.",
                "maxLength": 262144
              },
              "short_description": {
                "type": "string",
                "description": "Product short description.",
                "maxLength": 262144
              },
              "sku": {
                "type": "string",
                "description": "Stock Keeping Unit.",
                "maxLength": 262144
              },
              "global_unique_id": {
                "type": "string",
                "description": "GTIN, UPC, EAN or ISBN.",
                "maxLength": 262144
              },
              "regular_price": {
                "type": "string",
                "description": "Product regular price.",
                "maxLength": 262144
              },
              "sale_price": {
                "type": "string",
                "description": "Product sale price.",
                "maxLength": 262144
              },
              "date_on_sale_from": {
                "type": "string",
                "description": "Start date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "date_on_sale_from_gmt": {
                "type": "string",
                "description": "Start date of sale price, as GMT.",
                "maxLength": 262144
              },
              "date_on_sale_to": {
                "type": "string",
                "description": "End date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "date_on_sale_to_gmt": {
                "type": "string",
                "description": "End date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "virtual": {
                "type": "boolean",
                "description": "If the product is virtual."
              },
              "downloadable": {
                "type": "boolean",
                "description": "If the product is downloadable."
              },
              "downloads": {
                "type": "array",
                "description": "List of downloadable files.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "description": "File ID.",
                      "maxLength": 262144
                    },
                    "name": {
                      "type": "string",
                      "description": "File name.",
                      "maxLength": 262144
                    },
                    "file": {
                      "type": "string",
                      "description": "File URL.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "download_limit": {
                "type": "integer",
                "description": "Number of times downloadable files can be downloaded after purchase.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "download_expiry": {
                "type": "integer",
                "description": "Number of days until access to downloadable files expires.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "external_url": {
                "type": "string",
                "description": "Product external URL. Only for external products.",
                "format": "uri",
                "maxLength": 262144
              },
              "button_text": {
                "type": "string",
                "description": "Product external button text. Only for external products.",
                "maxLength": 262144
              },
              "tax_status": {
                "type": "string",
                "description": "Tax status.",
                "maxLength": 262144
              },
              "tax_class": {
                "type": "string",
                "description": "Tax class.",
                "maxLength": 262144
              },
              "manage_stock": {
                "type": "boolean",
                "description": "Stock management at product level."
              },
              "stock_quantity": {
                "type": "number",
                "description": "Stock quantity."
              },
              "stock_status": {
                "type": "string",
                "description": "Controls the stock status of the product.",
                "maxLength": 262144
              },
              "backorders": {
                "type": "string",
                "enum": [
                  "no",
                  "notify",
                  "yes"
                ],
                "description": "If managing stock, this controls if backorders are allowed.",
                "maxLength": 262144
              },
              "low_stock_amount": {
                "type": [
                  "integer",
                  "null"
                ],
                "description": "Low Stock amount for the product."
              },
              "sold_individually": {
                "type": "boolean",
                "description": "Allow one item to be bought in a single order."
              },
              "weight": {
                "type": "string",
                "maxLength": 262144
              },
              "dimensions": {
                "type": "object",
                "description": "Product dimensions.",
                "properties": {
                  "length": {
                    "type": "string",
                    "maxLength": 262144
                  },
                  "width": {
                    "type": "string",
                    "maxLength": 262144
                  },
                  "height": {
                    "type": "string",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "shipping_class": {
                "type": "string",
                "description": "Shipping class slug.",
                "maxLength": 262144
              },
              "reviews_allowed": {
                "type": "boolean",
                "description": "Allow reviews."
              },
              "post_password": {
                "type": "string",
                "description": "Post password.",
                "maxLength": 262144
              },
              "upsell_ids": {
                "type": "array",
                "description": "List of up-sell products IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "cross_sell_ids": {
                "type": "array",
                "description": "List of cross-sell products IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "parent_id": {
                "type": "integer",
                "description": "Product parent ID.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "purchase_note": {
                "type": "string",
                "description": "Optional note to send the customer after purchase.",
                "maxLength": 262144
              },
              "categories": {
                "type": "array",
                "description": "List of categories.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Category ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Category name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "Category slug.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "brands": {
                "type": "array",
                "description": "List of brands.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Brand ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Brand name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "Brand slug.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "tags": {
                "type": "array",
                "description": "List of tags.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Tag ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Tag name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "Tag slug.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "images": {
                "type": "array",
                "description": "List of images.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Image ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "date_created": {
                      "type": "string",
                      "description": "The date the image was created, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_created_gmt": {
                      "type": "string",
                      "description": "The date the image was created, as GMT.",
                      "maxLength": 262144
                    },
                    "date_modified": {
                      "type": "string",
                      "description": "The date the image was last modified, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_modified_gmt": {
                      "type": "string",
                      "description": "The date the image was last modified, as GMT.",
                      "maxLength": 262144
                    },
                    "src": {
                      "type": "string",
                      "description": "Image URL.",
                      "format": "uri",
                      "maxLength": 262144
                    },
                    "name": {
                      "type": "string",
                      "description": "Image name.",
                      "maxLength": 262144
                    },
                    "alt": {
                      "type": "string",
                      "description": "Image alternative text.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "attributes": {
                "type": "array",
                "description": "List of attributes.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Attribute ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Attribute name.",
                      "maxLength": 262144
                    },
                    "position": {
                      "type": "integer",
                      "description": "Attribute position.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "visible": {
                      "type": "boolean",
                      "description": "Define if the attribute is visible on the \"Additional information\" tab in the product's page."
                    },
                    "variation": {
                      "type": "boolean",
                      "description": "Define if the attribute can be used as variation."
                    },
                    "options": {
                      "type": "array",
                      "description": "List of available term names of the attribute.",
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
              "default_attributes": {
                "type": "array",
                "description": "Defaults variation attributes.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Attribute ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Attribute name.",
                      "maxLength": 262144
                    },
                    "option": {
                      "type": "string",
                      "description": "Selected attribute term name.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "menu_order": {
                "type": "integer",
                "description": "Menu order, used to custom sort products.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "description": "Meta value."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /products — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/{id}": {
      "method": "GET",
      "path": "/products/{id}",
      "risk": "R",
      "resource": "products",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "image_size": {
                "type": "string",
                "description": "Use a specific registered image size for the returned image src values. Falls back to the full size if the requested size is not registered.",
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
      "ack_key": "id",
      "description": "GET /products/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /products/{id}": {
      "method": "PUT",
      "path": "/products/{id}",
      "risk": "H",
      "resource": "products",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Product name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "Product slug.",
                "maxLength": 262144
              },
              "date_created": {
                "type": "string",
                "description": "The date the product was created, in the site's timezone.",
                "maxLength": 262144
              },
              "date_created_gmt": {
                "type": "string",
                "description": "The date the product was created, as GMT.",
                "maxLength": 262144
              },
              "type": {
                "type": "string",
                "description": "Product type.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "description": "Product status (post status).",
                "maxLength": 262144
              },
              "featured": {
                "type": "boolean",
                "description": "Featured product."
              },
              "catalog_visibility": {
                "type": "string",
                "description": "Catalog visibility.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "Product description.",
                "maxLength": 262144
              },
              "short_description": {
                "type": "string",
                "description": "Product short description.",
                "maxLength": 262144
              },
              "sku": {
                "type": "string",
                "description": "Stock Keeping Unit.",
                "maxLength": 262144
              },
              "global_unique_id": {
                "type": "string",
                "description": "GTIN, UPC, EAN or ISBN.",
                "maxLength": 262144
              },
              "regular_price": {
                "type": "string",
                "description": "Product regular price.",
                "maxLength": 262144
              },
              "sale_price": {
                "type": "string",
                "description": "Product sale price.",
                "maxLength": 262144
              },
              "date_on_sale_from": {
                "type": "string",
                "description": "Start date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "date_on_sale_from_gmt": {
                "type": "string",
                "description": "Start date of sale price, as GMT.",
                "maxLength": 262144
              },
              "date_on_sale_to": {
                "type": "string",
                "description": "End date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "date_on_sale_to_gmt": {
                "type": "string",
                "description": "End date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "virtual": {
                "type": "boolean",
                "description": "If the product is virtual."
              },
              "downloadable": {
                "type": "boolean",
                "description": "If the product is downloadable."
              },
              "downloads": {
                "type": "array",
                "description": "List of downloadable files.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "description": "File ID.",
                      "maxLength": 262144
                    },
                    "name": {
                      "type": "string",
                      "description": "File name.",
                      "maxLength": 262144
                    },
                    "file": {
                      "type": "string",
                      "description": "File URL.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "download_limit": {
                "type": "integer",
                "description": "Number of times downloadable files can be downloaded after purchase.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "download_expiry": {
                "type": "integer",
                "description": "Number of days until access to downloadable files expires.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "external_url": {
                "type": "string",
                "description": "Product external URL. Only for external products.",
                "format": "uri",
                "maxLength": 262144
              },
              "button_text": {
                "type": "string",
                "description": "Product external button text. Only for external products.",
                "maxLength": 262144
              },
              "tax_status": {
                "type": "string",
                "description": "Tax status.",
                "maxLength": 262144
              },
              "tax_class": {
                "type": "string",
                "description": "Tax class.",
                "maxLength": 262144
              },
              "manage_stock": {
                "type": "boolean",
                "description": "Stock management at product level."
              },
              "stock_quantity": {
                "type": "number",
                "description": "Stock quantity."
              },
              "stock_status": {
                "type": "string",
                "description": "Controls the stock status of the product.",
                "maxLength": 262144
              },
              "backorders": {
                "type": "string",
                "enum": [
                  "no",
                  "notify",
                  "yes"
                ],
                "description": "If managing stock, this controls if backorders are allowed.",
                "maxLength": 262144
              },
              "low_stock_amount": {
                "type": [
                  "integer",
                  "null"
                ],
                "description": "Low Stock amount for the product."
              },
              "sold_individually": {
                "type": "boolean",
                "description": "Allow one item to be bought in a single order."
              },
              "weight": {
                "type": "string",
                "maxLength": 262144
              },
              "dimensions": {
                "type": "object",
                "description": "Product dimensions.",
                "properties": {
                  "length": {
                    "type": "string",
                    "maxLength": 262144
                  },
                  "width": {
                    "type": "string",
                    "maxLength": 262144
                  },
                  "height": {
                    "type": "string",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "shipping_class": {
                "type": "string",
                "description": "Shipping class slug.",
                "maxLength": 262144
              },
              "reviews_allowed": {
                "type": "boolean",
                "description": "Allow reviews."
              },
              "post_password": {
                "type": "string",
                "description": "Post password.",
                "maxLength": 262144
              },
              "upsell_ids": {
                "type": "array",
                "description": "List of up-sell products IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "cross_sell_ids": {
                "type": "array",
                "description": "List of cross-sell products IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "parent_id": {
                "type": "integer",
                "description": "Product parent ID.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "purchase_note": {
                "type": "string",
                "description": "Optional note to send the customer after purchase.",
                "maxLength": 262144
              },
              "categories": {
                "type": "array",
                "description": "List of categories.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Category ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Category name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "Category slug.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "brands": {
                "type": "array",
                "description": "List of brands.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Brand ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Brand name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "Brand slug.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "tags": {
                "type": "array",
                "description": "List of tags.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Tag ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Tag name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "Tag slug.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "images": {
                "type": "array",
                "description": "List of images.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Image ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "date_created": {
                      "type": "string",
                      "description": "The date the image was created, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_created_gmt": {
                      "type": "string",
                      "description": "The date the image was created, as GMT.",
                      "maxLength": 262144
                    },
                    "date_modified": {
                      "type": "string",
                      "description": "The date the image was last modified, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_modified_gmt": {
                      "type": "string",
                      "description": "The date the image was last modified, as GMT.",
                      "maxLength": 262144
                    },
                    "src": {
                      "type": "string",
                      "description": "Image URL.",
                      "format": "uri",
                      "maxLength": 262144
                    },
                    "name": {
                      "type": "string",
                      "description": "Image name.",
                      "maxLength": 262144
                    },
                    "alt": {
                      "type": "string",
                      "description": "Image alternative text.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "attributes": {
                "type": "array",
                "description": "List of attributes.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Attribute ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Attribute name.",
                      "maxLength": 262144
                    },
                    "position": {
                      "type": "integer",
                      "description": "Attribute position.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "visible": {
                      "type": "boolean",
                      "description": "Define if the attribute is visible on the \"Additional information\" tab in the product's page."
                    },
                    "variation": {
                      "type": "boolean",
                      "description": "Define if the attribute can be used as variation."
                    },
                    "options": {
                      "type": "array",
                      "description": "List of available term names of the attribute.",
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
              "default_attributes": {
                "type": "array",
                "description": "Defaults variation attributes.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Attribute ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Attribute name.",
                      "maxLength": 262144
                    },
                    "option": {
                      "type": "string",
                      "description": "Selected attribute term name.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "menu_order": {
                "type": "integer",
                "description": "Menu order, used to custom sort products.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "description": "Meta value."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /products/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /products/{id}": {
      "method": "DELETE",
      "path": "/products/{id}",
      "risk": "D",
      "resource": "products",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Whether to bypass trash and force deletion."
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
      "ack_key": "id",
      "description": "DELETE /products/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /products/batch": {
      "method": "POST",
      "path": "/products/batch",
      "risk": "D",
      "resource": "products",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Product name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "Product slug.",
                      "maxLength": 262144
                    },
                    "date_created": {
                      "type": "string",
                      "description": "The date the product was created, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_created_gmt": {
                      "type": "string",
                      "description": "The date the product was created, as GMT.",
                      "maxLength": 262144
                    },
                    "type": {
                      "type": "string",
                      "description": "Product type.",
                      "maxLength": 262144
                    },
                    "status": {
                      "type": "string",
                      "description": "Product status (post status).",
                      "maxLength": 262144
                    },
                    "featured": {
                      "type": "boolean",
                      "description": "Featured product."
                    },
                    "catalog_visibility": {
                      "type": "string",
                      "description": "Catalog visibility.",
                      "maxLength": 262144
                    },
                    "description": {
                      "type": "string",
                      "description": "Product description.",
                      "maxLength": 262144
                    },
                    "short_description": {
                      "type": "string",
                      "description": "Product short description.",
                      "maxLength": 262144
                    },
                    "sku": {
                      "type": "string",
                      "description": "Stock Keeping Unit.",
                      "maxLength": 262144
                    },
                    "global_unique_id": {
                      "type": "string",
                      "description": "GTIN, UPC, EAN or ISBN.",
                      "maxLength": 262144
                    },
                    "regular_price": {
                      "type": "string",
                      "description": "Product regular price.",
                      "maxLength": 262144
                    },
                    "sale_price": {
                      "type": "string",
                      "description": "Product sale price.",
                      "maxLength": 262144
                    },
                    "date_on_sale_from": {
                      "type": "string",
                      "description": "Start date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_on_sale_from_gmt": {
                      "type": "string",
                      "description": "Start date of sale price, as GMT.",
                      "maxLength": 262144
                    },
                    "date_on_sale_to": {
                      "type": "string",
                      "description": "End date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_on_sale_to_gmt": {
                      "type": "string",
                      "description": "End date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "virtual": {
                      "type": "boolean",
                      "description": "If the product is virtual."
                    },
                    "downloadable": {
                      "type": "boolean",
                      "description": "If the product is downloadable."
                    },
                    "downloads": {
                      "type": "array",
                      "description": "List of downloadable files.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "description": "File ID.",
                            "maxLength": 262144
                          },
                          "name": {
                            "type": "string",
                            "description": "File name.",
                            "maxLength": 262144
                          },
                          "file": {
                            "type": "string",
                            "description": "File URL.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "download_limit": {
                      "type": "integer",
                      "description": "Number of times downloadable files can be downloaded after purchase.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "download_expiry": {
                      "type": "integer",
                      "description": "Number of days until access to downloadable files expires.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "external_url": {
                      "type": "string",
                      "description": "Product external URL. Only for external products.",
                      "format": "uri",
                      "maxLength": 262144
                    },
                    "button_text": {
                      "type": "string",
                      "description": "Product external button text. Only for external products.",
                      "maxLength": 262144
                    },
                    "tax_status": {
                      "type": "string",
                      "description": "Tax status.",
                      "maxLength": 262144
                    },
                    "tax_class": {
                      "type": "string",
                      "description": "Tax class.",
                      "maxLength": 262144
                    },
                    "manage_stock": {
                      "type": "boolean",
                      "description": "Stock management at product level."
                    },
                    "stock_quantity": {
                      "type": "number",
                      "description": "Stock quantity."
                    },
                    "stock_status": {
                      "type": "string",
                      "description": "Controls the stock status of the product.",
                      "maxLength": 262144
                    },
                    "backorders": {
                      "type": "string",
                      "enum": [
                        "no",
                        "notify",
                        "yes"
                      ],
                      "description": "If managing stock, this controls if backorders are allowed.",
                      "maxLength": 262144
                    },
                    "low_stock_amount": {
                      "type": [
                        "integer",
                        "null"
                      ],
                      "description": "Low Stock amount for the product."
                    },
                    "sold_individually": {
                      "type": "boolean",
                      "description": "Allow one item to be bought in a single order."
                    },
                    "weight": {
                      "type": "string",
                      "maxLength": 262144
                    },
                    "dimensions": {
                      "type": "object",
                      "description": "Product dimensions.",
                      "properties": {
                        "length": {
                          "type": "string",
                          "maxLength": 262144
                        },
                        "width": {
                          "type": "string",
                          "maxLength": 262144
                        },
                        "height": {
                          "type": "string",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "shipping_class": {
                      "type": "string",
                      "description": "Shipping class slug.",
                      "maxLength": 262144
                    },
                    "reviews_allowed": {
                      "type": "boolean",
                      "description": "Allow reviews."
                    },
                    "post_password": {
                      "type": "string",
                      "description": "Post password.",
                      "maxLength": 262144
                    },
                    "upsell_ids": {
                      "type": "array",
                      "description": "List of up-sell products IDs.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "cross_sell_ids": {
                      "type": "array",
                      "description": "List of cross-sell products IDs.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "parent_id": {
                      "type": "integer",
                      "description": "Product parent ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "purchase_note": {
                      "type": "string",
                      "description": "Optional note to send the customer after purchase.",
                      "maxLength": 262144
                    },
                    "categories": {
                      "type": "array",
                      "description": "List of categories.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Category ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Category name.",
                            "maxLength": 262144
                          },
                          "slug": {
                            "type": "string",
                            "description": "Category slug.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "brands": {
                      "type": "array",
                      "description": "List of brands.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Brand ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Brand name.",
                            "maxLength": 262144
                          },
                          "slug": {
                            "type": "string",
                            "description": "Brand slug.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "tags": {
                      "type": "array",
                      "description": "List of tags.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Tag ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Tag name.",
                            "maxLength": 262144
                          },
                          "slug": {
                            "type": "string",
                            "description": "Tag slug.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "images": {
                      "type": "array",
                      "description": "List of images.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Image ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "date_created": {
                            "type": "string",
                            "description": "The date the image was created, in the site's timezone.",
                            "maxLength": 262144
                          },
                          "date_created_gmt": {
                            "type": "string",
                            "description": "The date the image was created, as GMT.",
                            "maxLength": 262144
                          },
                          "date_modified": {
                            "type": "string",
                            "description": "The date the image was last modified, in the site's timezone.",
                            "maxLength": 262144
                          },
                          "date_modified_gmt": {
                            "type": "string",
                            "description": "The date the image was last modified, as GMT.",
                            "maxLength": 262144
                          },
                          "src": {
                            "type": "string",
                            "description": "Image URL.",
                            "format": "uri",
                            "maxLength": 262144
                          },
                          "name": {
                            "type": "string",
                            "description": "Image name.",
                            "maxLength": 262144
                          },
                          "alt": {
                            "type": "string",
                            "description": "Image alternative text.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "attributes": {
                      "type": "array",
                      "description": "List of attributes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Attribute ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Attribute name.",
                            "maxLength": 262144
                          },
                          "position": {
                            "type": "integer",
                            "description": "Attribute position.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "visible": {
                            "type": "boolean",
                            "description": "Define if the attribute is visible on the \"Additional information\" tab in the product's page."
                          },
                          "variation": {
                            "type": "boolean",
                            "description": "Define if the attribute can be used as variation."
                          },
                          "options": {
                            "type": "array",
                            "description": "List of available term names of the attribute.",
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
                    "default_attributes": {
                      "type": "array",
                      "description": "Defaults variation attributes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Attribute ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Attribute name.",
                            "maxLength": 262144
                          },
                          "option": {
                            "type": "string",
                            "description": "Selected attribute term name.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "menu_order": {
                      "type": "integer",
                      "description": "Menu order, used to custom sort products.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "description": "Meta value."
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    }
                  },
                  "additionalProperties": false,
                  "required": []
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Product name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "Product slug.",
                      "maxLength": 262144
                    },
                    "date_created": {
                      "type": "string",
                      "description": "The date the product was created, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_created_gmt": {
                      "type": "string",
                      "description": "The date the product was created, as GMT.",
                      "maxLength": 262144
                    },
                    "type": {
                      "type": "string",
                      "description": "Product type.",
                      "maxLength": 262144
                    },
                    "status": {
                      "type": "string",
                      "description": "Product status (post status).",
                      "maxLength": 262144
                    },
                    "featured": {
                      "type": "boolean",
                      "description": "Featured product."
                    },
                    "catalog_visibility": {
                      "type": "string",
                      "description": "Catalog visibility.",
                      "maxLength": 262144
                    },
                    "description": {
                      "type": "string",
                      "description": "Product description.",
                      "maxLength": 262144
                    },
                    "short_description": {
                      "type": "string",
                      "description": "Product short description.",
                      "maxLength": 262144
                    },
                    "sku": {
                      "type": "string",
                      "description": "Stock Keeping Unit.",
                      "maxLength": 262144
                    },
                    "global_unique_id": {
                      "type": "string",
                      "description": "GTIN, UPC, EAN or ISBN.",
                      "maxLength": 262144
                    },
                    "regular_price": {
                      "type": "string",
                      "description": "Product regular price.",
                      "maxLength": 262144
                    },
                    "sale_price": {
                      "type": "string",
                      "description": "Product sale price.",
                      "maxLength": 262144
                    },
                    "date_on_sale_from": {
                      "type": "string",
                      "description": "Start date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_on_sale_from_gmt": {
                      "type": "string",
                      "description": "Start date of sale price, as GMT.",
                      "maxLength": 262144
                    },
                    "date_on_sale_to": {
                      "type": "string",
                      "description": "End date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_on_sale_to_gmt": {
                      "type": "string",
                      "description": "End date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "virtual": {
                      "type": "boolean",
                      "description": "If the product is virtual."
                    },
                    "downloadable": {
                      "type": "boolean",
                      "description": "If the product is downloadable."
                    },
                    "downloads": {
                      "type": "array",
                      "description": "List of downloadable files.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "description": "File ID.",
                            "maxLength": 262144
                          },
                          "name": {
                            "type": "string",
                            "description": "File name.",
                            "maxLength": 262144
                          },
                          "file": {
                            "type": "string",
                            "description": "File URL.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "download_limit": {
                      "type": "integer",
                      "description": "Number of times downloadable files can be downloaded after purchase.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "download_expiry": {
                      "type": "integer",
                      "description": "Number of days until access to downloadable files expires.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "external_url": {
                      "type": "string",
                      "description": "Product external URL. Only for external products.",
                      "format": "uri",
                      "maxLength": 262144
                    },
                    "button_text": {
                      "type": "string",
                      "description": "Product external button text. Only for external products.",
                      "maxLength": 262144
                    },
                    "tax_status": {
                      "type": "string",
                      "description": "Tax status.",
                      "maxLength": 262144
                    },
                    "tax_class": {
                      "type": "string",
                      "description": "Tax class.",
                      "maxLength": 262144
                    },
                    "manage_stock": {
                      "type": "boolean",
                      "description": "Stock management at product level."
                    },
                    "stock_quantity": {
                      "type": "number",
                      "description": "Stock quantity."
                    },
                    "stock_status": {
                      "type": "string",
                      "description": "Controls the stock status of the product.",
                      "maxLength": 262144
                    },
                    "backorders": {
                      "type": "string",
                      "enum": [
                        "no",
                        "notify",
                        "yes"
                      ],
                      "description": "If managing stock, this controls if backorders are allowed.",
                      "maxLength": 262144
                    },
                    "low_stock_amount": {
                      "type": [
                        "integer",
                        "null"
                      ],
                      "description": "Low Stock amount for the product."
                    },
                    "sold_individually": {
                      "type": "boolean",
                      "description": "Allow one item to be bought in a single order."
                    },
                    "weight": {
                      "type": "string",
                      "maxLength": 262144
                    },
                    "dimensions": {
                      "type": "object",
                      "description": "Product dimensions.",
                      "properties": {
                        "length": {
                          "type": "string",
                          "maxLength": 262144
                        },
                        "width": {
                          "type": "string",
                          "maxLength": 262144
                        },
                        "height": {
                          "type": "string",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "shipping_class": {
                      "type": "string",
                      "description": "Shipping class slug.",
                      "maxLength": 262144
                    },
                    "reviews_allowed": {
                      "type": "boolean",
                      "description": "Allow reviews."
                    },
                    "post_password": {
                      "type": "string",
                      "description": "Post password.",
                      "maxLength": 262144
                    },
                    "upsell_ids": {
                      "type": "array",
                      "description": "List of up-sell products IDs.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "cross_sell_ids": {
                      "type": "array",
                      "description": "List of cross-sell products IDs.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "parent_id": {
                      "type": "integer",
                      "description": "Product parent ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "purchase_note": {
                      "type": "string",
                      "description": "Optional note to send the customer after purchase.",
                      "maxLength": 262144
                    },
                    "categories": {
                      "type": "array",
                      "description": "List of categories.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Category ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Category name.",
                            "maxLength": 262144
                          },
                          "slug": {
                            "type": "string",
                            "description": "Category slug.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "brands": {
                      "type": "array",
                      "description": "List of brands.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Brand ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Brand name.",
                            "maxLength": 262144
                          },
                          "slug": {
                            "type": "string",
                            "description": "Brand slug.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "tags": {
                      "type": "array",
                      "description": "List of tags.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Tag ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Tag name.",
                            "maxLength": 262144
                          },
                          "slug": {
                            "type": "string",
                            "description": "Tag slug.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "images": {
                      "type": "array",
                      "description": "List of images.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Image ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "date_created": {
                            "type": "string",
                            "description": "The date the image was created, in the site's timezone.",
                            "maxLength": 262144
                          },
                          "date_created_gmt": {
                            "type": "string",
                            "description": "The date the image was created, as GMT.",
                            "maxLength": 262144
                          },
                          "date_modified": {
                            "type": "string",
                            "description": "The date the image was last modified, in the site's timezone.",
                            "maxLength": 262144
                          },
                          "date_modified_gmt": {
                            "type": "string",
                            "description": "The date the image was last modified, as GMT.",
                            "maxLength": 262144
                          },
                          "src": {
                            "type": "string",
                            "description": "Image URL.",
                            "format": "uri",
                            "maxLength": 262144
                          },
                          "name": {
                            "type": "string",
                            "description": "Image name.",
                            "maxLength": 262144
                          },
                          "alt": {
                            "type": "string",
                            "description": "Image alternative text.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "attributes": {
                      "type": "array",
                      "description": "List of attributes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Attribute ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Attribute name.",
                            "maxLength": 262144
                          },
                          "position": {
                            "type": "integer",
                            "description": "Attribute position.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "visible": {
                            "type": "boolean",
                            "description": "Define if the attribute is visible on the \"Additional information\" tab in the product's page."
                          },
                          "variation": {
                            "type": "boolean",
                            "description": "Define if the attribute can be used as variation."
                          },
                          "options": {
                            "type": "array",
                            "description": "List of available term names of the attribute.",
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
                    "default_attributes": {
                      "type": "array",
                      "description": "Defaults variation attributes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Attribute ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Attribute name.",
                            "maxLength": 262144
                          },
                          "option": {
                            "type": "string",
                            "description": "Selected attribute term name.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "menu_order": {
                      "type": "integer",
                      "description": "Menu order, used to custom sort products.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "description": "Meta value."
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /products/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/{product_id}/variations": {
      "method": "GET",
      "path": "/products/{product_id}/variations",
      "risk": "R",
      "resource": "products/{product_id}/variations",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "product_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "description": "Current page of the collection.",
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Maximum number of items to be returned in result set."
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "after": {
                "type": "string",
                "description": "Limit response to resources published after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "before": {
                "type": "string",
                "description": "Limit response to resources published before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "date",
                  "id",
                  "include",
                  "title",
                  "slug",
                  "modified"
                ],
                "description": "Sort collection by object attribute.",
                "maxLength": 262144
              },
              "parent": {
                "type": "array",
                "description": "Limit result set to those of particular parent IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "parent_exclude": {
                "type": "array",
                "description": "Limit result set to all items except those of a particular parent ID.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "slug": {
                "type": "string",
                "description": "Limit result set to products with a specific slug.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "enum": [
                  "any",
                  "draft",
                  "pending",
                  "private",
                  "publish"
                ],
                "description": "Limit result set to products assigned a specific status.",
                "maxLength": 262144
              },
              "type": {
                "type": "string",
                "enum": [
                  "simple",
                  "grouped",
                  "external",
                  "variable"
                ],
                "description": "Limit result set to products assigned a specific type.",
                "maxLength": 262144
              },
              "sku": {
                "type": "string",
                "description": "Limit result set to products with a specific SKU.",
                "maxLength": 262144
              },
              "featured": {
                "type": "boolean",
                "description": "Limit result set to featured products."
              },
              "category": {
                "type": "string",
                "description": "Limit result set to products assigned a specific category ID.",
                "maxLength": 262144
              },
              "tag": {
                "type": "string",
                "description": "Limit result set to products assigned a specific tag ID.",
                "maxLength": 262144
              },
              "shipping_class": {
                "type": "string",
                "description": "Limit result set to products assigned a specific shipping class ID.",
                "maxLength": 262144
              },
              "attribute": {
                "type": "string",
                "description": "Limit result set to products with a specific attribute.",
                "maxLength": 262144
              },
              "attribute_term": {
                "type": "string",
                "description": "Limit result set to products with a specific attribute term ID (required an assigned attribute).",
                "maxLength": 262144
              },
              "tax_class": {
                "type": "string",
                "enum": [
                  "standard",
                  "reduced-rate",
                  "zero-rate"
                ],
                "description": "Limit result set to products with a specific tax class.",
                "maxLength": 262144
              },
              "in_stock": {
                "type": "boolean",
                "description": "Limit result set to products in stock or out of stock."
              },
              "on_sale": {
                "type": "boolean",
                "description": "Limit result set to products on sale."
              },
              "min_price": {
                "type": "string",
                "description": "Limit result set to products based on a minimum price.",
                "maxLength": 262144
              },
              "max_price": {
                "type": "string",
                "description": "Limit result set to products based on a maximum price.",
                "maxLength": 262144
              },
              "image_size": {
                "type": "string",
                "description": "Use a specific registered image size for the returned variation image src. Falls back to the full size if the requested size is not registered.",
                "maxLength": 262144
              },
              "modified_after": {
                "type": "string",
                "description": "Limit response to resources modified after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "modified_before": {
                "type": "string",
                "description": "Limit response to resources modified before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "dates_are_gmt": {
                "type": "boolean",
                "description": "Whether to consider GMT post dates when limiting response by published or modified date."
              },
              "stock_status": {
                "type": "string",
                "description": "Limit result set to products with specified stock status.",
                "maxLength": 262144
              },
              "has_price": {
                "type": "boolean",
                "description": "Limit result set to products with or without price."
              },
              "attributes": {
                "type": "array",
                "description": "Limit result set to products with specified attributes.",
                "items": {
                  "type": "object",
                  "properties": {
                    "attribute": {
                      "type": "string",
                      "description": "Attribute slug.",
                      "maxLength": 262144
                    },
                    "term": {
                      "type": "string",
                      "description": "Attribute term.",
                      "maxLength": 262144
                    },
                    "terms": {
                      "type": "array",
                      "description": "Attribute terms.",
                      "items": {},
                      "maxItems": 100
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 100
              },
              "virtual": {
                "type": "boolean",
                "description": "Limit result set to virtual product variations."
              },
              "downloadable": {
                "type": "boolean",
                "description": "Limit result set to downloadable product variations."
              },
              "include_status": {
                "type": "array",
                "description": "Limit result set to product variations with any of the statuses.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "exclude_status": {
                "type": "array",
                "description": "Exclude product variations with any of the statuses from result set.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "pos_products_only": {
                "type": "boolean",
                "description": "Limit result set to variations visible in Point of Sale."
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
      "ack_key": null,
      "description": "GET /products/{product_id}/variations — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /products/{product_id}/variations": {
      "method": "POST",
      "path": "/products/{product_id}/variations",
      "risk": "H",
      "resource": "products/{product_id}/variations",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "product_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "description": {
                "type": "string",
                "description": "Variation description.",
                "maxLength": 262144
              },
              "sku": {
                "type": "string",
                "description": "Stock Keeping Unit.",
                "maxLength": 262144
              },
              "global_unique_id": {
                "type": "string",
                "description": "GTIN, UPC, EAN or ISBN.",
                "maxLength": 262144
              },
              "regular_price": {
                "type": "string",
                "description": "Variation regular price.",
                "maxLength": 262144
              },
              "sale_price": {
                "type": "string",
                "description": "Variation sale price.",
                "maxLength": 262144
              },
              "date_on_sale_from": {
                "type": "string",
                "description": "Start date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "date_on_sale_from_gmt": {
                "type": "string",
                "description": "Start date of sale price, as GMT.",
                "maxLength": 262144
              },
              "date_on_sale_to": {
                "type": "string",
                "description": "End date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "date_on_sale_to_gmt": {
                "type": "string",
                "description": "End date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "description": "Variation status.",
                "maxLength": 262144
              },
              "virtual": {
                "type": "boolean",
                "description": "If the variation is virtual."
              },
              "downloadable": {
                "type": "boolean",
                "description": "If the variation is downloadable."
              },
              "downloads": {
                "type": "array",
                "description": "List of downloadable files.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "description": "File ID.",
                      "maxLength": 262144
                    },
                    "name": {
                      "type": "string",
                      "description": "File name.",
                      "maxLength": 262144
                    },
                    "file": {
                      "type": "string",
                      "description": "File URL.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "download_limit": {
                "type": "integer",
                "description": "Number of times downloadable files can be downloaded after purchase.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "download_expiry": {
                "type": "integer",
                "description": "Number of days until access to downloadable files expires.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "tax_status": {
                "type": "string",
                "description": "Tax status.",
                "maxLength": 262144
              },
              "tax_class": {
                "type": "string",
                "description": "Tax class.",
                "maxLength": 262144
              },
              "manage_stock": {
                "type": [
                  "boolean",
                  "string"
                ],
                "description": "Stock management at variation level."
              },
              "stock_quantity": {
                "type": "integer",
                "description": "Stock quantity.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "stock_status": {
                "type": "string",
                "description": "Controls the stock status of the product.",
                "maxLength": 262144
              },
              "backorders": {
                "type": "string",
                "enum": [
                  "no",
                  "notify",
                  "yes"
                ],
                "description": "If managing stock, this controls if backorders are allowed.",
                "maxLength": 262144
              },
              "low_stock_amount": {
                "type": [
                  "integer",
                  "null"
                ],
                "description": "Low Stock amount for the variation."
              },
              "weight": {
                "type": "string",
                "maxLength": 262144
              },
              "dimensions": {
                "type": "object",
                "description": "Variation dimensions.",
                "properties": {
                  "length": {
                    "type": "string",
                    "maxLength": 262144
                  },
                  "width": {
                    "type": "string",
                    "maxLength": 262144
                  },
                  "height": {
                    "type": "string",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "shipping_class": {
                "type": "string",
                "description": "Shipping class slug.",
                "maxLength": 262144
              },
              "image": {
                "type": "object",
                "description": "Variation image data.",
                "properties": {
                  "id": {
                    "type": "integer",
                    "description": "Image ID.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  "date_created": {
                    "type": "string",
                    "description": "The date the image was created, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_created_gmt": {
                    "type": "string",
                    "description": "The date the image was created, as GMT.",
                    "maxLength": 262144
                  },
                  "date_modified": {
                    "type": "string",
                    "description": "The date the image was last modified, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_modified_gmt": {
                    "type": "string",
                    "description": "The date the image was last modified, as GMT.",
                    "maxLength": 262144
                  },
                  "src": {
                    "type": "string",
                    "description": "Image URL.",
                    "format": "uri",
                    "maxLength": 262144
                  },
                  "name": {
                    "type": "string",
                    "description": "Image name.",
                    "maxLength": 262144
                  },
                  "alt": {
                    "type": "string",
                    "description": "Image alternative text.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "gallery_image_ids": {
                "type": "array",
                "description": "Variation gallery image IDs, excluding the featured image (which is set via \"image\"). Mirrors how galleries work on parent products.",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "attributes": {
                "type": "array",
                "description": "List of attributes.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Attribute ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Attribute name.",
                      "maxLength": 262144
                    },
                    "option": {
                      "type": "string",
                      "description": "Selected attribute term name.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "menu_order": {
                "type": "integer",
                "description": "Menu order, used to custom sort products.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "description": "Meta value."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /products/{product_id}/variations — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/{product_id}/variations/{id}": {
      "method": "GET",
      "path": "/products/{product_id}/variations/{id}",
      "risk": "R",
      "resource": "products/{product_id}/variations",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "product_id",
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "image_size": {
                "type": "string",
                "description": "Use a specific registered image size for the returned variation image src. Falls back to the full size if the requested size is not registered.",
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
      "ack_key": "id",
      "description": "GET /products/{product_id}/variations/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /products/{product_id}/variations/{id}": {
      "method": "PUT",
      "path": "/products/{product_id}/variations/{id}",
      "risk": "H",
      "resource": "products/{product_id}/variations",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "product_id",
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "description": {
                "type": "string",
                "description": "Variation description.",
                "maxLength": 262144
              },
              "sku": {
                "type": "string",
                "description": "Stock Keeping Unit.",
                "maxLength": 262144
              },
              "global_unique_id": {
                "type": "string",
                "description": "GTIN, UPC, EAN or ISBN.",
                "maxLength": 262144
              },
              "regular_price": {
                "type": "string",
                "description": "Variation regular price.",
                "maxLength": 262144
              },
              "sale_price": {
                "type": "string",
                "description": "Variation sale price.",
                "maxLength": 262144
              },
              "date_on_sale_from": {
                "type": "string",
                "description": "Start date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "date_on_sale_from_gmt": {
                "type": "string",
                "description": "Start date of sale price, as GMT.",
                "maxLength": 262144
              },
              "date_on_sale_to": {
                "type": "string",
                "description": "End date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "date_on_sale_to_gmt": {
                "type": "string",
                "description": "End date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "description": "Variation status.",
                "maxLength": 262144
              },
              "virtual": {
                "type": "boolean",
                "description": "If the variation is virtual."
              },
              "downloadable": {
                "type": "boolean",
                "description": "If the variation is downloadable."
              },
              "downloads": {
                "type": "array",
                "description": "List of downloadable files.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "description": "File ID.",
                      "maxLength": 262144
                    },
                    "name": {
                      "type": "string",
                      "description": "File name.",
                      "maxLength": 262144
                    },
                    "file": {
                      "type": "string",
                      "description": "File URL.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "download_limit": {
                "type": "integer",
                "description": "Number of times downloadable files can be downloaded after purchase.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "download_expiry": {
                "type": "integer",
                "description": "Number of days until access to downloadable files expires.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "tax_status": {
                "type": "string",
                "description": "Tax status.",
                "maxLength": 262144
              },
              "tax_class": {
                "type": "string",
                "description": "Tax class.",
                "maxLength": 262144
              },
              "manage_stock": {
                "type": [
                  "boolean",
                  "string"
                ],
                "description": "Stock management at variation level."
              },
              "stock_quantity": {
                "type": "integer",
                "description": "Stock quantity.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "stock_status": {
                "type": "string",
                "description": "Controls the stock status of the product.",
                "maxLength": 262144
              },
              "backorders": {
                "type": "string",
                "enum": [
                  "no",
                  "notify",
                  "yes"
                ],
                "description": "If managing stock, this controls if backorders are allowed.",
                "maxLength": 262144
              },
              "low_stock_amount": {
                "type": [
                  "integer",
                  "null"
                ],
                "description": "Low Stock amount for the variation."
              },
              "weight": {
                "type": "string",
                "maxLength": 262144
              },
              "dimensions": {
                "type": "object",
                "description": "Variation dimensions.",
                "properties": {
                  "length": {
                    "type": "string",
                    "maxLength": 262144
                  },
                  "width": {
                    "type": "string",
                    "maxLength": 262144
                  },
                  "height": {
                    "type": "string",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "shipping_class": {
                "type": "string",
                "description": "Shipping class slug.",
                "maxLength": 262144
              },
              "image": {
                "type": "object",
                "description": "Variation image data.",
                "properties": {
                  "id": {
                    "type": "integer",
                    "description": "Image ID.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  "date_created": {
                    "type": "string",
                    "description": "The date the image was created, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_created_gmt": {
                    "type": "string",
                    "description": "The date the image was created, as GMT.",
                    "maxLength": 262144
                  },
                  "date_modified": {
                    "type": "string",
                    "description": "The date the image was last modified, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_modified_gmt": {
                    "type": "string",
                    "description": "The date the image was last modified, as GMT.",
                    "maxLength": 262144
                  },
                  "src": {
                    "type": "string",
                    "description": "Image URL.",
                    "format": "uri",
                    "maxLength": 262144
                  },
                  "name": {
                    "type": "string",
                    "description": "Image name.",
                    "maxLength": 262144
                  },
                  "alt": {
                    "type": "string",
                    "description": "Image alternative text.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "gallery_image_ids": {
                "type": "array",
                "description": "Variation gallery image IDs, excluding the featured image (which is set via \"image\"). Mirrors how galleries work on parent products.",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "attributes": {
                "type": "array",
                "description": "List of attributes.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Attribute ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Attribute name.",
                      "maxLength": 262144
                    },
                    "option": {
                      "type": "string",
                      "description": "Selected attribute term name.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "menu_order": {
                "type": "integer",
                "description": "Menu order, used to custom sort products.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "description": "Meta value."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /products/{product_id}/variations/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /products/{product_id}/variations/{id}": {
      "method": "DELETE",
      "path": "/products/{product_id}/variations/{id}",
      "risk": "D",
      "resource": "products/{product_id}/variations",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "product_id",
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Whether to bypass trash and force deletion."
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
      "ack_key": "id",
      "description": "DELETE /products/{product_id}/variations/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /products/{product_id}/variations/batch": {
      "method": "POST",
      "path": "/products/{product_id}/variations/batch",
      "risk": "D",
      "resource": "products/{product_id}/variations",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "product_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "description": {
                      "type": "string",
                      "description": "Variation description.",
                      "maxLength": 262144
                    },
                    "sku": {
                      "type": "string",
                      "description": "Stock Keeping Unit.",
                      "maxLength": 262144
                    },
                    "global_unique_id": {
                      "type": "string",
                      "description": "GTIN, UPC, EAN or ISBN.",
                      "maxLength": 262144
                    },
                    "regular_price": {
                      "type": "string",
                      "description": "Variation regular price.",
                      "maxLength": 262144
                    },
                    "sale_price": {
                      "type": "string",
                      "description": "Variation sale price.",
                      "maxLength": 262144
                    },
                    "date_on_sale_from": {
                      "type": "string",
                      "description": "Start date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_on_sale_from_gmt": {
                      "type": "string",
                      "description": "Start date of sale price, as GMT.",
                      "maxLength": 262144
                    },
                    "date_on_sale_to": {
                      "type": "string",
                      "description": "End date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_on_sale_to_gmt": {
                      "type": "string",
                      "description": "End date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "status": {
                      "type": "string",
                      "description": "Variation status.",
                      "maxLength": 262144
                    },
                    "virtual": {
                      "type": "boolean",
                      "description": "If the variation is virtual."
                    },
                    "downloadable": {
                      "type": "boolean",
                      "description": "If the variation is downloadable."
                    },
                    "downloads": {
                      "type": "array",
                      "description": "List of downloadable files.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "description": "File ID.",
                            "maxLength": 262144
                          },
                          "name": {
                            "type": "string",
                            "description": "File name.",
                            "maxLength": 262144
                          },
                          "file": {
                            "type": "string",
                            "description": "File URL.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "download_limit": {
                      "type": "integer",
                      "description": "Number of times downloadable files can be downloaded after purchase.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "download_expiry": {
                      "type": "integer",
                      "description": "Number of days until access to downloadable files expires.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "tax_status": {
                      "type": "string",
                      "description": "Tax status.",
                      "maxLength": 262144
                    },
                    "tax_class": {
                      "type": "string",
                      "description": "Tax class.",
                      "maxLength": 262144
                    },
                    "manage_stock": {
                      "type": [
                        "boolean",
                        "string"
                      ],
                      "description": "Stock management at variation level."
                    },
                    "stock_quantity": {
                      "type": "integer",
                      "description": "Stock quantity.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "stock_status": {
                      "type": "string",
                      "description": "Controls the stock status of the product.",
                      "maxLength": 262144
                    },
                    "backorders": {
                      "type": "string",
                      "enum": [
                        "no",
                        "notify",
                        "yes"
                      ],
                      "description": "If managing stock, this controls if backorders are allowed.",
                      "maxLength": 262144
                    },
                    "low_stock_amount": {
                      "type": [
                        "integer",
                        "null"
                      ],
                      "description": "Low Stock amount for the variation."
                    },
                    "weight": {
                      "type": "string",
                      "maxLength": 262144
                    },
                    "dimensions": {
                      "type": "object",
                      "description": "Variation dimensions.",
                      "properties": {
                        "length": {
                          "type": "string",
                          "maxLength": 262144
                        },
                        "width": {
                          "type": "string",
                          "maxLength": 262144
                        },
                        "height": {
                          "type": "string",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "shipping_class": {
                      "type": "string",
                      "description": "Shipping class slug.",
                      "maxLength": 262144
                    },
                    "image": {
                      "type": "object",
                      "description": "Variation image data.",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "description": "Image ID.",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "date_created": {
                          "type": "string",
                          "description": "The date the image was created, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_created_gmt": {
                          "type": "string",
                          "description": "The date the image was created, as GMT.",
                          "maxLength": 262144
                        },
                        "date_modified": {
                          "type": "string",
                          "description": "The date the image was last modified, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_modified_gmt": {
                          "type": "string",
                          "description": "The date the image was last modified, as GMT.",
                          "maxLength": 262144
                        },
                        "src": {
                          "type": "string",
                          "description": "Image URL.",
                          "format": "uri",
                          "maxLength": 262144
                        },
                        "name": {
                          "type": "string",
                          "description": "Image name.",
                          "maxLength": 262144
                        },
                        "alt": {
                          "type": "string",
                          "description": "Image alternative text.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "gallery_image_ids": {
                      "type": "array",
                      "description": "Variation gallery image IDs, excluding the featured image (which is set via \"image\"). Mirrors how galleries work on parent products.",
                      "items": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "attributes": {
                      "type": "array",
                      "description": "List of attributes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Attribute ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Attribute name.",
                            "maxLength": 262144
                          },
                          "option": {
                            "type": "string",
                            "description": "Selected attribute term name.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "menu_order": {
                      "type": "integer",
                      "description": "Menu order, used to custom sort products.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "description": "Meta value."
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    }
                  },
                  "additionalProperties": false,
                  "required": []
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "description": {
                      "type": "string",
                      "description": "Variation description.",
                      "maxLength": 262144
                    },
                    "sku": {
                      "type": "string",
                      "description": "Stock Keeping Unit.",
                      "maxLength": 262144
                    },
                    "global_unique_id": {
                      "type": "string",
                      "description": "GTIN, UPC, EAN or ISBN.",
                      "maxLength": 262144
                    },
                    "regular_price": {
                      "type": "string",
                      "description": "Variation regular price.",
                      "maxLength": 262144
                    },
                    "sale_price": {
                      "type": "string",
                      "description": "Variation sale price.",
                      "maxLength": 262144
                    },
                    "date_on_sale_from": {
                      "type": "string",
                      "description": "Start date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_on_sale_from_gmt": {
                      "type": "string",
                      "description": "Start date of sale price, as GMT.",
                      "maxLength": 262144
                    },
                    "date_on_sale_to": {
                      "type": "string",
                      "description": "End date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_on_sale_to_gmt": {
                      "type": "string",
                      "description": "End date of sale price, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "status": {
                      "type": "string",
                      "description": "Variation status.",
                      "maxLength": 262144
                    },
                    "virtual": {
                      "type": "boolean",
                      "description": "If the variation is virtual."
                    },
                    "downloadable": {
                      "type": "boolean",
                      "description": "If the variation is downloadable."
                    },
                    "downloads": {
                      "type": "array",
                      "description": "List of downloadable files.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "description": "File ID.",
                            "maxLength": 262144
                          },
                          "name": {
                            "type": "string",
                            "description": "File name.",
                            "maxLength": 262144
                          },
                          "file": {
                            "type": "string",
                            "description": "File URL.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "download_limit": {
                      "type": "integer",
                      "description": "Number of times downloadable files can be downloaded after purchase.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "download_expiry": {
                      "type": "integer",
                      "description": "Number of days until access to downloadable files expires.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "tax_status": {
                      "type": "string",
                      "description": "Tax status.",
                      "maxLength": 262144
                    },
                    "tax_class": {
                      "type": "string",
                      "description": "Tax class.",
                      "maxLength": 262144
                    },
                    "manage_stock": {
                      "type": [
                        "boolean",
                        "string"
                      ],
                      "description": "Stock management at variation level."
                    },
                    "stock_quantity": {
                      "type": "integer",
                      "description": "Stock quantity.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "stock_status": {
                      "type": "string",
                      "description": "Controls the stock status of the product.",
                      "maxLength": 262144
                    },
                    "backorders": {
                      "type": "string",
                      "enum": [
                        "no",
                        "notify",
                        "yes"
                      ],
                      "description": "If managing stock, this controls if backorders are allowed.",
                      "maxLength": 262144
                    },
                    "low_stock_amount": {
                      "type": [
                        "integer",
                        "null"
                      ],
                      "description": "Low Stock amount for the variation."
                    },
                    "weight": {
                      "type": "string",
                      "maxLength": 262144
                    },
                    "dimensions": {
                      "type": "object",
                      "description": "Variation dimensions.",
                      "properties": {
                        "length": {
                          "type": "string",
                          "maxLength": 262144
                        },
                        "width": {
                          "type": "string",
                          "maxLength": 262144
                        },
                        "height": {
                          "type": "string",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "shipping_class": {
                      "type": "string",
                      "description": "Shipping class slug.",
                      "maxLength": 262144
                    },
                    "image": {
                      "type": "object",
                      "description": "Variation image data.",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "description": "Image ID.",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "date_created": {
                          "type": "string",
                          "description": "The date the image was created, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_created_gmt": {
                          "type": "string",
                          "description": "The date the image was created, as GMT.",
                          "maxLength": 262144
                        },
                        "date_modified": {
                          "type": "string",
                          "description": "The date the image was last modified, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_modified_gmt": {
                          "type": "string",
                          "description": "The date the image was last modified, as GMT.",
                          "maxLength": 262144
                        },
                        "src": {
                          "type": "string",
                          "description": "Image URL.",
                          "format": "uri",
                          "maxLength": 262144
                        },
                        "name": {
                          "type": "string",
                          "description": "Image name.",
                          "maxLength": 262144
                        },
                        "alt": {
                          "type": "string",
                          "description": "Image alternative text.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "gallery_image_ids": {
                      "type": "array",
                      "description": "Variation gallery image IDs, excluding the featured image (which is set via \"image\"). Mirrors how galleries work on parent products.",
                      "items": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "attributes": {
                      "type": "array",
                      "description": "List of attributes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Attribute ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "type": "string",
                            "description": "Attribute name.",
                            "maxLength": 262144
                          },
                          "option": {
                            "type": "string",
                            "description": "Selected attribute term name.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "menu_order": {
                      "type": "integer",
                      "description": "Menu order, used to custom sort products.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "description": "Meta value."
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /products/{product_id}/variations/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/categories": {
      "method": "GET",
      "path": "/products/categories",
      "risk": "R",
      "resource": "products/categories",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "description": "Current page of the collection.",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "description": "Maximum number of items to be returned in result set.",
                "minimum": 1,
                "maximum": 100
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "id",
                  "include",
                  "name",
                  "slug",
                  "term_group",
                  "description",
                  "count"
                ],
                "description": "Sort collection by resource attribute.",
                "maxLength": 262144
              },
              "hide_empty": {
                "type": "boolean",
                "description": "Whether to hide resources not assigned to any products."
              },
              "parent": {
                "type": "integer",
                "description": "Limit result set to resources assigned to a specific parent. Applies to hierarchical taxonomies only.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "product": {
                "type": "integer",
                "description": "Limit result set to resources assigned to a specific product.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "slug": {
                "type": [
                  "string",
                  "array"
                ],
                "description": "Limit result set to resources with a specific slug.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items. Applies to hierarchical taxonomies only.",
                "minimum": 0,
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
      "ack_key": null,
      "description": "GET /products/categories — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /products/categories": {
      "method": "POST",
      "path": "/products/categories",
      "risk": "W",
      "resource": "products/categories",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Category name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "parent": {
                "type": "integer",
                "description": "The ID for the parent of the resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "description": {
                "type": "string",
                "description": "HTML description of the resource.",
                "maxLength": 262144
              },
              "display": {
                "type": "string",
                "enum": [
                  "default",
                  "products",
                  "subcategories",
                  "both"
                ],
                "description": "Category archive display type.",
                "maxLength": 262144
              },
              "image": {
                "type": "object",
                "description": "Image data.",
                "properties": {
                  "id": {
                    "type": "integer",
                    "description": "Image ID.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  "date_created": {
                    "type": "string",
                    "description": "The date the image was created, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_created_gmt": {
                    "type": "string",
                    "description": "The date the image was created, as GMT.",
                    "maxLength": 262144
                  },
                  "date_modified": {
                    "type": "string",
                    "description": "The date the image was last modified, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_modified_gmt": {
                    "type": "string",
                    "description": "The date the image was last modified, as GMT.",
                    "maxLength": 262144
                  },
                  "src": {
                    "type": "string",
                    "description": "Image URL.",
                    "format": "uri",
                    "maxLength": 262144
                  },
                  "name": {
                    "type": "string",
                    "description": "Image name.",
                    "maxLength": 262144
                  },
                  "alt": {
                    "type": "string",
                    "description": "Image alternative text.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "menu_order": {
                "type": "integer",
                "description": "Menu order, used to custom sort the resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false,
            "required": [
              "name"
            ]
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /products/categories — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/categories/{id}": {
      "method": "GET",
      "path": "/products/categories/{id}",
      "risk": "R",
      "resource": "products/categories",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /products/categories/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /products/categories/{id}": {
      "method": "PUT",
      "path": "/products/categories/{id}",
      "risk": "W",
      "resource": "products/categories",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Category name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "parent": {
                "type": "integer",
                "description": "The ID for the parent of the resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "description": {
                "type": "string",
                "description": "HTML description of the resource.",
                "maxLength": 262144
              },
              "display": {
                "type": "string",
                "enum": [
                  "default",
                  "products",
                  "subcategories",
                  "both"
                ],
                "description": "Category archive display type.",
                "maxLength": 262144
              },
              "image": {
                "type": "object",
                "description": "Image data.",
                "properties": {
                  "id": {
                    "type": "integer",
                    "description": "Image ID.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  "date_created": {
                    "type": "string",
                    "description": "The date the image was created, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_created_gmt": {
                    "type": "string",
                    "description": "The date the image was created, as GMT.",
                    "maxLength": 262144
                  },
                  "date_modified": {
                    "type": "string",
                    "description": "The date the image was last modified, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_modified_gmt": {
                    "type": "string",
                    "description": "The date the image was last modified, as GMT.",
                    "maxLength": 262144
                  },
                  "src": {
                    "type": "string",
                    "description": "Image URL.",
                    "format": "uri",
                    "maxLength": 262144
                  },
                  "name": {
                    "type": "string",
                    "description": "Image name.",
                    "maxLength": 262144
                  },
                  "alt": {
                    "type": "string",
                    "description": "Image alternative text.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "menu_order": {
                "type": "integer",
                "description": "Menu order, used to custom sort the resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /products/categories/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /products/categories/{id}": {
      "method": "DELETE",
      "path": "/products/categories/{id}",
      "risk": "D",
      "resource": "products/categories",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Required to be true, as resource does not support trashing."
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
      "ack_key": "id",
      "description": "DELETE /products/categories/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /products/categories/batch": {
      "method": "POST",
      "path": "/products/categories/batch",
      "risk": "D",
      "resource": "products/categories",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Category name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "parent": {
                      "type": "integer",
                      "description": "The ID for the parent of the resource.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "description": {
                      "type": "string",
                      "description": "HTML description of the resource.",
                      "maxLength": 262144
                    },
                    "display": {
                      "type": "string",
                      "enum": [
                        "default",
                        "products",
                        "subcategories",
                        "both"
                      ],
                      "description": "Category archive display type.",
                      "maxLength": 262144
                    },
                    "image": {
                      "type": "object",
                      "description": "Image data.",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "description": "Image ID.",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "date_created": {
                          "type": "string",
                          "description": "The date the image was created, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_created_gmt": {
                          "type": "string",
                          "description": "The date the image was created, as GMT.",
                          "maxLength": 262144
                        },
                        "date_modified": {
                          "type": "string",
                          "description": "The date the image was last modified, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_modified_gmt": {
                          "type": "string",
                          "description": "The date the image was last modified, as GMT.",
                          "maxLength": 262144
                        },
                        "src": {
                          "type": "string",
                          "description": "Image URL.",
                          "format": "uri",
                          "maxLength": 262144
                        },
                        "name": {
                          "type": "string",
                          "description": "Image name.",
                          "maxLength": 262144
                        },
                        "alt": {
                          "type": "string",
                          "description": "Image alternative text.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "menu_order": {
                      "type": "integer",
                      "description": "Menu order, used to custom sort the resource.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "name"
                  ]
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Category name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "parent": {
                      "type": "integer",
                      "description": "The ID for the parent of the resource.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "description": {
                      "type": "string",
                      "description": "HTML description of the resource.",
                      "maxLength": 262144
                    },
                    "display": {
                      "type": "string",
                      "enum": [
                        "default",
                        "products",
                        "subcategories",
                        "both"
                      ],
                      "description": "Category archive display type.",
                      "maxLength": 262144
                    },
                    "image": {
                      "type": "object",
                      "description": "Image data.",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "description": "Image ID.",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "date_created": {
                          "type": "string",
                          "description": "The date the image was created, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_created_gmt": {
                          "type": "string",
                          "description": "The date the image was created, as GMT.",
                          "maxLength": 262144
                        },
                        "date_modified": {
                          "type": "string",
                          "description": "The date the image was last modified, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_modified_gmt": {
                          "type": "string",
                          "description": "The date the image was last modified, as GMT.",
                          "maxLength": 262144
                        },
                        "src": {
                          "type": "string",
                          "description": "Image URL.",
                          "format": "uri",
                          "maxLength": 262144
                        },
                        "name": {
                          "type": "string",
                          "description": "Image name.",
                          "maxLength": 262144
                        },
                        "alt": {
                          "type": "string",
                          "description": "Image alternative text.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "menu_order": {
                      "type": "integer",
                      "description": "Menu order, used to custom sort the resource.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /products/categories/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/brands": {
      "method": "GET",
      "path": "/products/brands",
      "risk": "R",
      "resource": "products/brands",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "description": "Current page of the collection.",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "description": "Maximum number of items to be returned in result set.",
                "minimum": 1,
                "maximum": 100
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "id",
                  "include",
                  "name",
                  "slug",
                  "term_group",
                  "description",
                  "count"
                ],
                "description": "Sort collection by resource attribute.",
                "maxLength": 262144
              },
              "hide_empty": {
                "type": "boolean",
                "description": "Whether to hide resources not assigned to any products."
              },
              "parent": {
                "type": "integer",
                "description": "Limit result set to resources assigned to a specific parent. Applies to hierarchical taxonomies only.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "product": {
                "type": "integer",
                "description": "Limit result set to resources assigned to a specific product.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "slug": {
                "type": [
                  "string",
                  "array"
                ],
                "description": "Limit result set to resources with a specific slug.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items. Applies to hierarchical taxonomies only.",
                "minimum": 0,
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
      "ack_key": null,
      "description": "GET /products/brands — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /products/brands": {
      "method": "POST",
      "path": "/products/brands",
      "risk": "W",
      "resource": "products/brands",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Category name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "parent": {
                "type": "integer",
                "description": "The ID for the parent of the resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "description": {
                "type": "string",
                "description": "HTML description of the resource.",
                "maxLength": 262144
              },
              "display": {
                "type": "string",
                "enum": [
                  "default",
                  "products",
                  "subcategories",
                  "both"
                ],
                "description": "Category archive display type.",
                "maxLength": 262144
              },
              "image": {
                "type": "object",
                "description": "Image data.",
                "properties": {
                  "id": {
                    "type": "integer",
                    "description": "Image ID.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  "date_created": {
                    "type": "string",
                    "description": "The date the image was created, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_created_gmt": {
                    "type": "string",
                    "description": "The date the image was created, as GMT.",
                    "maxLength": 262144
                  },
                  "date_modified": {
                    "type": "string",
                    "description": "The date the image was last modified, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_modified_gmt": {
                    "type": "string",
                    "description": "The date the image was last modified, as GMT.",
                    "maxLength": 262144
                  },
                  "src": {
                    "type": "string",
                    "description": "Image URL.",
                    "format": "uri",
                    "maxLength": 262144
                  },
                  "name": {
                    "type": "string",
                    "description": "Image name.",
                    "maxLength": 262144
                  },
                  "alt": {
                    "type": "string",
                    "description": "Image alternative text.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "menu_order": {
                "type": "integer",
                "description": "Menu order, used to custom sort the resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false,
            "required": [
              "name"
            ]
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /products/brands — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/brands/{id}": {
      "method": "GET",
      "path": "/products/brands/{id}",
      "risk": "R",
      "resource": "products/brands",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /products/brands/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /products/brands/{id}": {
      "method": "PUT",
      "path": "/products/brands/{id}",
      "risk": "W",
      "resource": "products/brands",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Category name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "parent": {
                "type": "integer",
                "description": "The ID for the parent of the resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "description": {
                "type": "string",
                "description": "HTML description of the resource.",
                "maxLength": 262144
              },
              "display": {
                "type": "string",
                "enum": [
                  "default",
                  "products",
                  "subcategories",
                  "both"
                ],
                "description": "Category archive display type.",
                "maxLength": 262144
              },
              "image": {
                "type": "object",
                "description": "Image data.",
                "properties": {
                  "id": {
                    "type": "integer",
                    "description": "Image ID.",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  "date_created": {
                    "type": "string",
                    "description": "The date the image was created, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_created_gmt": {
                    "type": "string",
                    "description": "The date the image was created, as GMT.",
                    "maxLength": 262144
                  },
                  "date_modified": {
                    "type": "string",
                    "description": "The date the image was last modified, in the site's timezone.",
                    "maxLength": 262144
                  },
                  "date_modified_gmt": {
                    "type": "string",
                    "description": "The date the image was last modified, as GMT.",
                    "maxLength": 262144
                  },
                  "src": {
                    "type": "string",
                    "description": "Image URL.",
                    "format": "uri",
                    "maxLength": 262144
                  },
                  "name": {
                    "type": "string",
                    "description": "Image name.",
                    "maxLength": 262144
                  },
                  "alt": {
                    "type": "string",
                    "description": "Image alternative text.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "menu_order": {
                "type": "integer",
                "description": "Menu order, used to custom sort the resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /products/brands/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /products/brands/{id}": {
      "method": "DELETE",
      "path": "/products/brands/{id}",
      "risk": "D",
      "resource": "products/brands",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Required to be true, as resource does not support trashing."
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
      "ack_key": "id",
      "description": "DELETE /products/brands/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /products/brands/batch": {
      "method": "POST",
      "path": "/products/brands/batch",
      "risk": "D",
      "resource": "products/brands",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Category name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "parent": {
                      "type": "integer",
                      "description": "The ID for the parent of the resource.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "description": {
                      "type": "string",
                      "description": "HTML description of the resource.",
                      "maxLength": 262144
                    },
                    "display": {
                      "type": "string",
                      "enum": [
                        "default",
                        "products",
                        "subcategories",
                        "both"
                      ],
                      "description": "Category archive display type.",
                      "maxLength": 262144
                    },
                    "image": {
                      "type": "object",
                      "description": "Image data.",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "description": "Image ID.",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "date_created": {
                          "type": "string",
                          "description": "The date the image was created, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_created_gmt": {
                          "type": "string",
                          "description": "The date the image was created, as GMT.",
                          "maxLength": 262144
                        },
                        "date_modified": {
                          "type": "string",
                          "description": "The date the image was last modified, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_modified_gmt": {
                          "type": "string",
                          "description": "The date the image was last modified, as GMT.",
                          "maxLength": 262144
                        },
                        "src": {
                          "type": "string",
                          "description": "Image URL.",
                          "format": "uri",
                          "maxLength": 262144
                        },
                        "name": {
                          "type": "string",
                          "description": "Image name.",
                          "maxLength": 262144
                        },
                        "alt": {
                          "type": "string",
                          "description": "Image alternative text.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "menu_order": {
                      "type": "integer",
                      "description": "Menu order, used to custom sort the resource.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "name"
                  ]
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Category name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "parent": {
                      "type": "integer",
                      "description": "The ID for the parent of the resource.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "description": {
                      "type": "string",
                      "description": "HTML description of the resource.",
                      "maxLength": 262144
                    },
                    "display": {
                      "type": "string",
                      "enum": [
                        "default",
                        "products",
                        "subcategories",
                        "both"
                      ],
                      "description": "Category archive display type.",
                      "maxLength": 262144
                    },
                    "image": {
                      "type": "object",
                      "description": "Image data.",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "description": "Image ID.",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "date_created": {
                          "type": "string",
                          "description": "The date the image was created, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_created_gmt": {
                          "type": "string",
                          "description": "The date the image was created, as GMT.",
                          "maxLength": 262144
                        },
                        "date_modified": {
                          "type": "string",
                          "description": "The date the image was last modified, in the site's timezone.",
                          "maxLength": 262144
                        },
                        "date_modified_gmt": {
                          "type": "string",
                          "description": "The date the image was last modified, as GMT.",
                          "maxLength": 262144
                        },
                        "src": {
                          "type": "string",
                          "description": "Image URL.",
                          "format": "uri",
                          "maxLength": 262144
                        },
                        "name": {
                          "type": "string",
                          "description": "Image name.",
                          "maxLength": 262144
                        },
                        "alt": {
                          "type": "string",
                          "description": "Image alternative text.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "menu_order": {
                      "type": "integer",
                      "description": "Menu order, used to custom sort the resource.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /products/brands/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/tags": {
      "method": "GET",
      "path": "/products/tags",
      "risk": "R",
      "resource": "products/tags",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "description": "Current page of the collection.",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "description": "Maximum number of items to be returned in result set.",
                "minimum": 1,
                "maximum": 100
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items. Applies to hierarchical taxonomies only.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "id",
                  "include",
                  "name",
                  "slug",
                  "term_group",
                  "description",
                  "count"
                ],
                "description": "Sort collection by resource attribute.",
                "maxLength": 262144
              },
              "hide_empty": {
                "type": "boolean",
                "description": "Whether to hide resources not assigned to any products."
              },
              "product": {
                "type": "integer",
                "description": "Limit result set to resources assigned to a specific product.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "slug": {
                "type": [
                  "string",
                  "array"
                ],
                "description": "Limit result set to resources with a specific slug.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "parent": {
                "type": "integer",
                "description": "Limit result set to resources assigned to a specific parent. Applies to hierarchical taxonomies only.",
                "minimum": -9007199254740991,
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
      "ack_key": null,
      "description": "GET /products/tags — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /products/tags": {
      "method": "POST",
      "path": "/products/tags",
      "risk": "W",
      "resource": "products/tags",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Tag name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "HTML description of the resource.",
                "maxLength": 262144
              }
            },
            "additionalProperties": false,
            "required": [
              "name"
            ]
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /products/tags — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/tags/{id}": {
      "method": "GET",
      "path": "/products/tags/{id}",
      "risk": "R",
      "resource": "products/tags",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /products/tags/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /products/tags/{id}": {
      "method": "PUT",
      "path": "/products/tags/{id}",
      "risk": "W",
      "resource": "products/tags",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Tag name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "HTML description of the resource.",
                "maxLength": 262144
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /products/tags/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /products/tags/{id}": {
      "method": "DELETE",
      "path": "/products/tags/{id}",
      "risk": "D",
      "resource": "products/tags",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Required to be true, as resource does not support trashing."
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
      "ack_key": "id",
      "description": "DELETE /products/tags/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /products/tags/batch": {
      "method": "POST",
      "path": "/products/tags/batch",
      "risk": "D",
      "resource": "products/tags",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Tag name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "description": {
                      "type": "string",
                      "description": "HTML description of the resource.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "name"
                  ]
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Tag name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "description": {
                      "type": "string",
                      "description": "HTML description of the resource.",
                      "maxLength": 262144
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /products/tags/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/attributes": {
      "method": "GET",
      "path": "/products/attributes",
      "risk": "R",
      "resource": "products/attributes",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
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
      "ack_key": null,
      "description": "GET /products/attributes — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /products/attributes": {
      "method": "POST",
      "path": "/products/attributes",
      "risk": "W",
      "resource": "products/attributes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Attribute name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "type": {
                "type": "string",
                "description": "Type of attribute.",
                "maxLength": 262144
              },
              "order_by": {
                "type": "string",
                "enum": [
                  "menu_order",
                  "name",
                  "name_num",
                  "id"
                ],
                "description": "Default sort order.",
                "maxLength": 262144
              },
              "has_archives": {
                "type": "boolean",
                "description": "Enable/Disable attribute archives."
              }
            },
            "additionalProperties": false,
            "required": [
              "name"
            ]
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /products/attributes — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/attributes/{id}": {
      "method": "GET",
      "path": "/products/attributes/{id}",
      "risk": "R",
      "resource": "products/attributes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /products/attributes/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /products/attributes/{id}": {
      "method": "PUT",
      "path": "/products/attributes/{id}",
      "risk": "W",
      "resource": "products/attributes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Attribute name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "type": {
                "type": "string",
                "description": "Type of attribute.",
                "maxLength": 262144
              },
              "order_by": {
                "type": "string",
                "enum": [
                  "menu_order",
                  "name",
                  "name_num",
                  "id"
                ],
                "description": "Default sort order.",
                "maxLength": 262144
              },
              "has_archives": {
                "type": "boolean",
                "description": "Enable/Disable attribute archives."
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /products/attributes/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /products/attributes/{id}": {
      "method": "DELETE",
      "path": "/products/attributes/{id}",
      "risk": "D",
      "resource": "products/attributes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Required to be true, as resource does not support trashing."
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
      "ack_key": "id",
      "description": "DELETE /products/attributes/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /products/attributes/batch": {
      "method": "POST",
      "path": "/products/attributes/batch",
      "risk": "D",
      "resource": "products/attributes",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Attribute name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "type": {
                      "type": "string",
                      "description": "Type of attribute.",
                      "maxLength": 262144
                    },
                    "order_by": {
                      "type": "string",
                      "enum": [
                        "menu_order",
                        "name",
                        "name_num",
                        "id"
                      ],
                      "description": "Default sort order.",
                      "maxLength": 262144
                    },
                    "has_archives": {
                      "type": "boolean",
                      "description": "Enable/Disable attribute archives."
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "name"
                  ]
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Attribute name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "type": {
                      "type": "string",
                      "description": "Type of attribute.",
                      "maxLength": 262144
                    },
                    "order_by": {
                      "type": "string",
                      "enum": [
                        "menu_order",
                        "name",
                        "name_num",
                        "id"
                      ],
                      "description": "Default sort order.",
                      "maxLength": 262144
                    },
                    "has_archives": {
                      "type": "boolean",
                      "description": "Enable/Disable attribute archives."
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /products/attributes/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/attributes/{attribute_id}/terms": {
      "method": "GET",
      "path": "/products/attributes/{attribute_id}/terms",
      "risk": "R",
      "resource": "products/attributes/{attribute_id}/terms",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "attribute_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "attribute_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "description": "Current page of the collection.",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "description": "Maximum number of items to be returned in result set.",
                "minimum": 1,
                "maximum": 100
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "id",
                  "include",
                  "name",
                  "slug",
                  "term_group",
                  "description",
                  "count"
                ],
                "description": "Sort collection by resource attribute.",
                "maxLength": 262144
              },
              "hide_empty": {
                "type": "boolean",
                "description": "Whether to hide resources not assigned to any products."
              },
              "parent": {
                "type": "integer",
                "description": "Limit result set to resources assigned to a specific parent. Applies to hierarchical taxonomies only.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "product": {
                "type": "integer",
                "description": "Limit result set to resources assigned to a specific product.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "slug": {
                "type": [
                  "string",
                  "array"
                ],
                "description": "Limit result set to resources with a specific slug.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items. Applies to hierarchical taxonomies only.",
                "minimum": 0,
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
      "ack_key": null,
      "description": "GET /products/attributes/{attribute_id}/terms — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /products/attributes/{attribute_id}/terms": {
      "method": "POST",
      "path": "/products/attributes/{attribute_id}/terms",
      "risk": "W",
      "resource": "products/attributes/{attribute_id}/terms",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "attribute_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "attribute_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Term name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "HTML description of the resource.",
                "maxLength": 262144
              },
              "menu_order": {
                "type": "integer",
                "description": "Menu order, used to custom sort the resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false,
            "required": [
              "name"
            ]
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /products/attributes/{attribute_id}/terms — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/attributes/{attribute_id}/terms/{id}": {
      "method": "GET",
      "path": "/products/attributes/{attribute_id}/terms/{id}",
      "risk": "R",
      "resource": "products/attributes/{attribute_id}/terms",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "attribute_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "attribute_id",
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /products/attributes/{attribute_id}/terms/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /products/attributes/{attribute_id}/terms/{id}": {
      "method": "PUT",
      "path": "/products/attributes/{attribute_id}/terms/{id}",
      "risk": "W",
      "resource": "products/attributes/{attribute_id}/terms",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "attribute_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "attribute_id",
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Term name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "HTML description of the resource.",
                "maxLength": 262144
              },
              "menu_order": {
                "type": "integer",
                "description": "Menu order, used to custom sort the resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /products/attributes/{attribute_id}/terms/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /products/attributes/{attribute_id}/terms/{id}": {
      "method": "DELETE",
      "path": "/products/attributes/{attribute_id}/terms/{id}",
      "risk": "D",
      "resource": "products/attributes/{attribute_id}/terms",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "attribute_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "attribute_id",
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Required to be true, as resource does not support trashing."
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
      "ack_key": "id",
      "description": "DELETE /products/attributes/{attribute_id}/terms/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /products/attributes/{attribute_id}/terms/batch": {
      "method": "POST",
      "path": "/products/attributes/{attribute_id}/terms/batch",
      "risk": "D",
      "resource": "products/attributes/{attribute_id}/terms",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "attribute_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "attribute_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Term name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "description": {
                      "type": "string",
                      "description": "HTML description of the resource.",
                      "maxLength": 262144
                    },
                    "menu_order": {
                      "type": "integer",
                      "description": "Menu order, used to custom sort the resource.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "name"
                  ]
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Term name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "description": {
                      "type": "string",
                      "description": "HTML description of the resource.",
                      "maxLength": 262144
                    },
                    "menu_order": {
                      "type": "integer",
                      "description": "Menu order, used to custom sort the resource.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /products/attributes/{attribute_id}/terms/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/shipping_classes": {
      "method": "GET",
      "path": "/products/shipping_classes",
      "risk": "R",
      "resource": "products/shipping_classes",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "description": "Current page of the collection.",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "description": "Maximum number of items to be returned in result set.",
                "minimum": 1,
                "maximum": 100
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items. Applies to hierarchical taxonomies only.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "id",
                  "include",
                  "name",
                  "slug",
                  "term_group",
                  "description",
                  "count"
                ],
                "description": "Sort collection by resource attribute.",
                "maxLength": 262144
              },
              "hide_empty": {
                "type": "boolean",
                "description": "Whether to hide resources not assigned to any products."
              },
              "product": {
                "type": "integer",
                "description": "Limit result set to resources assigned to a specific product.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "slug": {
                "type": [
                  "string",
                  "array"
                ],
                "description": "Limit result set to resources with a specific slug.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "parent": {
                "type": "integer",
                "description": "Limit result set to resources assigned to a specific parent. Applies to hierarchical taxonomies only.",
                "minimum": -9007199254740991,
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
      "ack_key": null,
      "description": "GET /products/shipping_classes — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /products/shipping_classes": {
      "method": "POST",
      "path": "/products/shipping_classes",
      "risk": "W",
      "resource": "products/shipping_classes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Shipping class name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "HTML description of the resource.",
                "maxLength": 262144
              }
            },
            "additionalProperties": false,
            "required": [
              "name"
            ]
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /products/shipping_classes — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/shipping_classes/{id}": {
      "method": "GET",
      "path": "/products/shipping_classes/{id}",
      "risk": "R",
      "resource": "products/shipping_classes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /products/shipping_classes/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /products/shipping_classes/{id}": {
      "method": "PUT",
      "path": "/products/shipping_classes/{id}",
      "risk": "W",
      "resource": "products/shipping_classes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Shipping class name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "An alphanumeric identifier for the resource unique to its type.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "HTML description of the resource.",
                "maxLength": 262144
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /products/shipping_classes/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /products/shipping_classes/{id}": {
      "method": "DELETE",
      "path": "/products/shipping_classes/{id}",
      "risk": "D",
      "resource": "products/shipping_classes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Required to be true, as resource does not support trashing."
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
      "ack_key": "id",
      "description": "DELETE /products/shipping_classes/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /products/shipping_classes/batch": {
      "method": "POST",
      "path": "/products/shipping_classes/batch",
      "risk": "D",
      "resource": "products/shipping_classes",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Shipping class name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "description": {
                      "type": "string",
                      "description": "HTML description of the resource.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "name"
                  ]
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "description": "Shipping class name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "An alphanumeric identifier for the resource unique to its type.",
                      "maxLength": 262144
                    },
                    "description": {
                      "type": "string",
                      "description": "HTML description of the resource.",
                      "maxLength": 262144
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /products/shipping_classes/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /orders": {
      "method": "GET",
      "path": "/orders",
      "risk": "R",
      "resource": "orders",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "description": "Current page of the collection.",
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Maximum number of items to be returned in result set."
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "after": {
                "type": "string",
                "description": "Limit response to resources published after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "before": {
                "type": "string",
                "description": "Limit response to resources published before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "date",
                  "id",
                  "include",
                  "title",
                  "slug",
                  "modified"
                ],
                "description": "Sort collection by object attribute.",
                "maxLength": 262144
              },
              "parent": {
                "type": "array",
                "description": "Limit result set to those of particular parent IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "parent_exclude": {
                "type": "array",
                "description": "Limit result set to all items except those of a particular parent ID.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "status": {
                "type": "array",
                "description": "Limit result set to orders which have specific statuses.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "customer": {
                "type": "integer",
                "description": "Limit result set to orders assigned a specific customer.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "product": {
                "type": "integer",
                "description": "Limit result set to orders assigned a specific product.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "dp": {
                "type": "integer",
                "description": "Number of decimal points to use in each resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "modified_after": {
                "type": "string",
                "description": "Limit response to resources modified after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "modified_before": {
                "type": "string",
                "description": "Limit response to resources modified before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "dates_are_gmt": {
                "type": "boolean",
                "description": "Whether to consider GMT post dates when limiting response by published or modified date."
              },
              "order_item_display_meta": {
                "type": "boolean",
                "description": "Only show meta which is meant to be displayed for an order."
              },
              "include_meta": {
                "type": "array",
                "description": "Limit meta_data to specific keys.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "exclude_meta": {
                "type": "array",
                "description": "Ensure meta_data excludes specific keys.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "created_via": {
                "type": "array",
                "description": "Limit result set to orders created via specific sources (e.g. checkout, admin).",
                "items": {
                  "type": "string",
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
      "ack_key": null,
      "description": "GET /orders — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /orders": {
      "method": "POST",
      "path": "/orders",
      "risk": "H",
      "resource": "orders",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "parent_id": {
                "type": "integer",
                "description": "Parent order ID.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "created_via": {
                "type": "string",
                "description": "Shows where the order was created.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "description": "Order status.",
                "maxLength": 262144
              },
              "currency": {
                "type": "string",
                "description": "Currency the order was created with, in ISO format.",
                "maxLength": 262144
              },
              "customer_id": {
                "type": "integer",
                "description": "User ID who owns the order. 0 for guests.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "customer_note": {
                "type": "string",
                "description": "Note left by customer during checkout.",
                "maxLength": 262144
              },
              "billing": {
                "type": "object",
                "description": "Billing address.",
                "properties": {
                  "first_name": {
                    "type": "string",
                    "description": "First name.",
                    "maxLength": 262144
                  },
                  "last_name": {
                    "type": "string",
                    "description": "Last name.",
                    "maxLength": 262144
                  },
                  "company": {
                    "type": "string",
                    "description": "Company name.",
                    "maxLength": 262144
                  },
                  "address_1": {
                    "type": "string",
                    "description": "Address line 1",
                    "maxLength": 262144
                  },
                  "address_2": {
                    "type": "string",
                    "description": "Address line 2",
                    "maxLength": 262144
                  },
                  "city": {
                    "type": "string",
                    "description": "City name.",
                    "maxLength": 262144
                  },
                  "state": {
                    "type": "string",
                    "description": "ISO code or name of the state, province or district.",
                    "maxLength": 262144
                  },
                  "postcode": {
                    "type": "string",
                    "description": "Postal code.",
                    "maxLength": 262144
                  },
                  "country": {
                    "type": "string",
                    "description": "Country code in ISO 3166-1 alpha-2 format.",
                    "maxLength": 262144
                  },
                  "email": {
                    "type": [
                      "string",
                      "null"
                    ],
                    "description": "Email address.",
                    "format": "email"
                  },
                  "phone": {
                    "type": "string",
                    "description": "Phone number.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "shipping": {
                "type": "object",
                "description": "Shipping address.",
                "properties": {
                  "first_name": {
                    "type": "string",
                    "description": "First name.",
                    "maxLength": 262144
                  },
                  "last_name": {
                    "type": "string",
                    "description": "Last name.",
                    "maxLength": 262144
                  },
                  "company": {
                    "type": "string",
                    "description": "Company name.",
                    "maxLength": 262144
                  },
                  "address_1": {
                    "type": "string",
                    "description": "Address line 1",
                    "maxLength": 262144
                  },
                  "address_2": {
                    "type": "string",
                    "description": "Address line 2",
                    "maxLength": 262144
                  },
                  "city": {
                    "type": "string",
                    "description": "City name.",
                    "maxLength": 262144
                  },
                  "state": {
                    "type": "string",
                    "description": "ISO code or name of the state, province or district.",
                    "maxLength": 262144
                  },
                  "postcode": {
                    "type": "string",
                    "description": "Postal code.",
                    "maxLength": 262144
                  },
                  "country": {
                    "type": "string",
                    "description": "Country code in ISO 3166-1 alpha-2 format.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "payment_method": {
                "type": "string",
                "description": "Payment method ID.",
                "maxLength": 262144
              },
              "payment_method_title": {
                "type": "string",
                "description": "Payment method title.",
                "maxLength": 262144
              },
              "transaction_id": {
                "type": "string",
                "description": "Unique transaction ID.",
                "maxLength": 262144
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "type": [
                        "null",
                        "object",
                        "string",
                        "number",
                        "boolean",
                        "integer",
                        "array"
                      ],
                      "description": "Meta value.",
                      "items": {},
                      "maxItems": 10
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "line_items": {
                "type": "array",
                "description": "Line items data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Item ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "description": "Product name."
                    },
                    "parent_name": {
                      "type": [
                        "string",
                        "null"
                      ],
                      "description": "Parent product name if the product is a variation."
                    },
                    "product_id": {
                      "description": "Product ID."
                    },
                    "variation_id": {
                      "type": "integer",
                      "description": "Variation ID, if applicable.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "quantity": {
                      "type": "integer",
                      "description": "Quantity ordered.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "tax_class": {
                      "type": "string",
                      "description": "Tax class of product.",
                      "maxLength": 262144
                    },
                    "subtotal": {
                      "type": "string",
                      "description": "Line subtotal, excluding tax (before discounts).",
                      "maxLength": 262144
                    },
                    "subtotal_tax": {
                      "type": "string",
                      "description": "Line subtotal tax (before discounts).",
                      "maxLength": 262144
                    },
                    "total": {
                      "type": "string",
                      "description": "Line total, excluding tax (after discounts).",
                      "maxLength": 262144
                    },
                    "total_tax": {
                      "type": "string",
                      "description": "Line total tax (after discounts).",
                      "maxLength": 262144
                    },
                    "taxes": {
                      "type": "array",
                      "description": "Line taxes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Tax rate ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "total": {
                            "type": "string",
                            "description": "Tax total.",
                            "maxLength": 262144
                          },
                          "subtotal": {
                            "type": "string",
                            "description": "Tax subtotal.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value.",
                            "items": {},
                            "maxItems": 10
                          },
                          "display_key": {
                            "type": "string",
                            "description": "Meta key for UI display.",
                            "maxLength": 262144
                          },
                          "display_value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value for UI display. May be a string or, when mirroring a complex meta value, an array or object.",
                            "items": {},
                            "maxItems": 10
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "sku": {
                      "type": "string",
                      "description": "Product SKU.",
                      "maxLength": 262144
                    },
                    "global_unique_id": {
                      "type": "string",
                      "description": "GTIN, UPC, EAN or ISBN.",
                      "maxLength": 262144
                    },
                    "price": {
                      "type": "number",
                      "description": "Product price."
                    },
                    "image": {
                      "type": "object",
                      "description": "Properties of the main product image.",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "description": "Image ID.",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "src": {
                          "type": "string",
                          "description": "Image URL.",
                          "format": "uri",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "shipping_lines": {
                "type": "array",
                "description": "Shipping lines data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Item ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "method_title": {
                      "description": "Shipping method name."
                    },
                    "method_id": {
                      "description": "Shipping method ID."
                    },
                    "instance_id": {
                      "type": "string",
                      "description": "Shipping instance ID.",
                      "maxLength": 262144
                    },
                    "total": {
                      "type": "string",
                      "description": "Shipping total, excluding tax.",
                      "maxLength": 262144
                    },
                    "total_tax": {
                      "type": "string",
                      "description": "Shipping total tax.",
                      "maxLength": 262144
                    },
                    "taxes": {
                      "type": "array",
                      "description": "Line taxes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Tax rate ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "total": {
                            "type": "string",
                            "description": "Tax total.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value.",
                            "items": {},
                            "maxItems": 10
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
              "fee_lines": {
                "type": "array",
                "description": "Fee lines data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Item ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "description": "Fee name."
                    },
                    "tax_class": {
                      "type": "string",
                      "description": "Tax class of fee.",
                      "maxLength": 262144
                    },
                    "tax_status": {
                      "type": "string",
                      "enum": [
                        "taxable",
                        "none"
                      ],
                      "description": "Tax status of fee.",
                      "maxLength": 262144
                    },
                    "total": {
                      "type": "string",
                      "description": "Fee total, excluding tax.",
                      "maxLength": 262144
                    },
                    "total_tax": {
                      "type": "string",
                      "description": "Fee total tax.",
                      "maxLength": 262144
                    },
                    "taxes": {
                      "type": "array",
                      "description": "Line taxes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Tax rate ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "total": {
                            "type": "string",
                            "description": "Tax total.",
                            "maxLength": 262144
                          },
                          "subtotal": {
                            "type": "string",
                            "description": "Tax subtotal.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value.",
                            "items": {},
                            "maxItems": 10
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
              "coupon_lines": {
                "type": "array",
                "description": "Coupons line data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Item ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "code": {
                      "description": "Coupon code."
                    },
                    "discount": {
                      "type": "string",
                      "description": "Discount total.",
                      "maxLength": 262144
                    },
                    "discount_tax": {
                      "type": "string",
                      "description": "Discount total tax.",
                      "maxLength": 262144
                    },
                    "discount_type": {
                      "type": "string",
                      "description": "Discount type.",
                      "maxLength": 262144
                    },
                    "nominal_amount": {
                      "type": "number",
                      "description": "Discount amount as defined in the coupon (absolute value or a percent, depending on the discount type)."
                    },
                    "free_shipping": {
                      "type": "boolean",
                      "description": "Whether the coupon grants free shipping or not."
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value.",
                            "items": {},
                            "maxItems": 10
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
              "set_paid": {
                "type": "boolean",
                "description": "Define if the order is paid. It will set the status to processing and reduce stock items."
              },
              "manual_update": {
                "type": "boolean",
                "description": "Set the action as manual so that the order note registers as \"added by user\"."
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /orders — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /orders/{id}": {
      "method": "GET",
      "path": "/orders/{id}",
      "risk": "R",
      "resource": "orders",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /orders/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /orders/{id}": {
      "method": "PUT",
      "path": "/orders/{id}",
      "risk": "H",
      "resource": "orders",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "parent_id": {
                "type": "integer",
                "description": "Parent order ID.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "created_via": {
                "type": "string",
                "description": "Shows where the order was created.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "description": "Order status.",
                "maxLength": 262144
              },
              "currency": {
                "type": "string",
                "description": "Currency the order was created with, in ISO format.",
                "maxLength": 262144
              },
              "customer_id": {
                "type": "integer",
                "description": "User ID who owns the order. 0 for guests.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "customer_note": {
                "type": "string",
                "description": "Note left by customer during checkout.",
                "maxLength": 262144
              },
              "billing": {
                "type": "object",
                "description": "Billing address.",
                "properties": {
                  "first_name": {
                    "type": "string",
                    "description": "First name.",
                    "maxLength": 262144
                  },
                  "last_name": {
                    "type": "string",
                    "description": "Last name.",
                    "maxLength": 262144
                  },
                  "company": {
                    "type": "string",
                    "description": "Company name.",
                    "maxLength": 262144
                  },
                  "address_1": {
                    "type": "string",
                    "description": "Address line 1",
                    "maxLength": 262144
                  },
                  "address_2": {
                    "type": "string",
                    "description": "Address line 2",
                    "maxLength": 262144
                  },
                  "city": {
                    "type": "string",
                    "description": "City name.",
                    "maxLength": 262144
                  },
                  "state": {
                    "type": "string",
                    "description": "ISO code or name of the state, province or district.",
                    "maxLength": 262144
                  },
                  "postcode": {
                    "type": "string",
                    "description": "Postal code.",
                    "maxLength": 262144
                  },
                  "country": {
                    "type": "string",
                    "description": "Country code in ISO 3166-1 alpha-2 format.",
                    "maxLength": 262144
                  },
                  "email": {
                    "type": [
                      "string",
                      "null"
                    ],
                    "description": "Email address.",
                    "format": "email"
                  },
                  "phone": {
                    "type": "string",
                    "description": "Phone number.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "shipping": {
                "type": "object",
                "description": "Shipping address.",
                "properties": {
                  "first_name": {
                    "type": "string",
                    "description": "First name.",
                    "maxLength": 262144
                  },
                  "last_name": {
                    "type": "string",
                    "description": "Last name.",
                    "maxLength": 262144
                  },
                  "company": {
                    "type": "string",
                    "description": "Company name.",
                    "maxLength": 262144
                  },
                  "address_1": {
                    "type": "string",
                    "description": "Address line 1",
                    "maxLength": 262144
                  },
                  "address_2": {
                    "type": "string",
                    "description": "Address line 2",
                    "maxLength": 262144
                  },
                  "city": {
                    "type": "string",
                    "description": "City name.",
                    "maxLength": 262144
                  },
                  "state": {
                    "type": "string",
                    "description": "ISO code or name of the state, province or district.",
                    "maxLength": 262144
                  },
                  "postcode": {
                    "type": "string",
                    "description": "Postal code.",
                    "maxLength": 262144
                  },
                  "country": {
                    "type": "string",
                    "description": "Country code in ISO 3166-1 alpha-2 format.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "payment_method": {
                "type": "string",
                "description": "Payment method ID.",
                "maxLength": 262144
              },
              "payment_method_title": {
                "type": "string",
                "description": "Payment method title.",
                "maxLength": 262144
              },
              "transaction_id": {
                "type": "string",
                "description": "Unique transaction ID.",
                "maxLength": 262144
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "type": [
                        "null",
                        "object",
                        "string",
                        "number",
                        "boolean",
                        "integer",
                        "array"
                      ],
                      "description": "Meta value.",
                      "items": {},
                      "maxItems": 10
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "line_items": {
                "type": "array",
                "description": "Line items data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Item ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "description": "Product name."
                    },
                    "parent_name": {
                      "type": [
                        "string",
                        "null"
                      ],
                      "description": "Parent product name if the product is a variation."
                    },
                    "product_id": {
                      "description": "Product ID."
                    },
                    "variation_id": {
                      "type": "integer",
                      "description": "Variation ID, if applicable.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "quantity": {
                      "type": "integer",
                      "description": "Quantity ordered.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "tax_class": {
                      "type": "string",
                      "description": "Tax class of product.",
                      "maxLength": 262144
                    },
                    "subtotal": {
                      "type": "string",
                      "description": "Line subtotal, excluding tax (before discounts).",
                      "maxLength": 262144
                    },
                    "subtotal_tax": {
                      "type": "string",
                      "description": "Line subtotal tax (before discounts).",
                      "maxLength": 262144
                    },
                    "total": {
                      "type": "string",
                      "description": "Line total, excluding tax (after discounts).",
                      "maxLength": 262144
                    },
                    "total_tax": {
                      "type": "string",
                      "description": "Line total tax (after discounts).",
                      "maxLength": 262144
                    },
                    "taxes": {
                      "type": "array",
                      "description": "Line taxes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Tax rate ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "total": {
                            "type": "string",
                            "description": "Tax total.",
                            "maxLength": 262144
                          },
                          "subtotal": {
                            "type": "string",
                            "description": "Tax subtotal.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value.",
                            "items": {},
                            "maxItems": 10
                          },
                          "display_key": {
                            "type": "string",
                            "description": "Meta key for UI display.",
                            "maxLength": 262144
                          },
                          "display_value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value for UI display. May be a string or, when mirroring a complex meta value, an array or object.",
                            "items": {},
                            "maxItems": 10
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "sku": {
                      "type": "string",
                      "description": "Product SKU.",
                      "maxLength": 262144
                    },
                    "global_unique_id": {
                      "type": "string",
                      "description": "GTIN, UPC, EAN or ISBN.",
                      "maxLength": 262144
                    },
                    "price": {
                      "type": "number",
                      "description": "Product price."
                    },
                    "image": {
                      "type": "object",
                      "description": "Properties of the main product image.",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "description": "Image ID.",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "src": {
                          "type": "string",
                          "description": "Image URL.",
                          "format": "uri",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "shipping_lines": {
                "type": "array",
                "description": "Shipping lines data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Item ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "method_title": {
                      "description": "Shipping method name."
                    },
                    "method_id": {
                      "description": "Shipping method ID."
                    },
                    "instance_id": {
                      "type": "string",
                      "description": "Shipping instance ID.",
                      "maxLength": 262144
                    },
                    "total": {
                      "type": "string",
                      "description": "Shipping total, excluding tax.",
                      "maxLength": 262144
                    },
                    "total_tax": {
                      "type": "string",
                      "description": "Shipping total tax.",
                      "maxLength": 262144
                    },
                    "taxes": {
                      "type": "array",
                      "description": "Line taxes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Tax rate ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "total": {
                            "type": "string",
                            "description": "Tax total.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value.",
                            "items": {},
                            "maxItems": 10
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
              "fee_lines": {
                "type": "array",
                "description": "Fee lines data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Item ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "description": "Fee name."
                    },
                    "tax_class": {
                      "type": "string",
                      "description": "Tax class of fee.",
                      "maxLength": 262144
                    },
                    "tax_status": {
                      "type": "string",
                      "enum": [
                        "taxable",
                        "none"
                      ],
                      "description": "Tax status of fee.",
                      "maxLength": 262144
                    },
                    "total": {
                      "type": "string",
                      "description": "Fee total, excluding tax.",
                      "maxLength": 262144
                    },
                    "total_tax": {
                      "type": "string",
                      "description": "Fee total tax.",
                      "maxLength": 262144
                    },
                    "taxes": {
                      "type": "array",
                      "description": "Line taxes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Tax rate ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "total": {
                            "type": "string",
                            "description": "Tax total.",
                            "maxLength": 262144
                          },
                          "subtotal": {
                            "type": "string",
                            "description": "Tax subtotal.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value.",
                            "items": {},
                            "maxItems": 10
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
              "coupon_lines": {
                "type": "array",
                "description": "Coupons line data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Item ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "code": {
                      "description": "Coupon code."
                    },
                    "discount": {
                      "type": "string",
                      "description": "Discount total.",
                      "maxLength": 262144
                    },
                    "discount_tax": {
                      "type": "string",
                      "description": "Discount total tax.",
                      "maxLength": 262144
                    },
                    "discount_type": {
                      "type": "string",
                      "description": "Discount type.",
                      "maxLength": 262144
                    },
                    "nominal_amount": {
                      "type": "number",
                      "description": "Discount amount as defined in the coupon (absolute value or a percent, depending on the discount type)."
                    },
                    "free_shipping": {
                      "type": "boolean",
                      "description": "Whether the coupon grants free shipping or not."
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value.",
                            "items": {},
                            "maxItems": 10
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
              "set_paid": {
                "type": "boolean",
                "description": "Define if the order is paid. It will set the status to processing and reduce stock items."
              },
              "manual_update": {
                "type": "boolean",
                "description": "Set the action as manual so that the order note registers as \"added by user\"."
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /orders/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /orders/{id}": {
      "method": "DELETE",
      "path": "/orders/{id}",
      "risk": "D",
      "resource": "orders",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Whether to bypass trash and force deletion."
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
      "ack_key": "id",
      "description": "DELETE /orders/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /orders/batch": {
      "method": "POST",
      "path": "/orders/batch",
      "risk": "D",
      "resource": "orders",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "parent_id": {
                      "type": "integer",
                      "description": "Parent order ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "created_via": {
                      "type": "string",
                      "description": "Shows where the order was created.",
                      "maxLength": 262144
                    },
                    "status": {
                      "type": "string",
                      "description": "Order status.",
                      "maxLength": 262144
                    },
                    "currency": {
                      "type": "string",
                      "description": "Currency the order was created with, in ISO format.",
                      "maxLength": 262144
                    },
                    "customer_id": {
                      "type": "integer",
                      "description": "User ID who owns the order. 0 for guests.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "customer_note": {
                      "type": "string",
                      "description": "Note left by customer during checkout.",
                      "maxLength": 262144
                    },
                    "billing": {
                      "type": "object",
                      "description": "Billing address.",
                      "properties": {
                        "first_name": {
                          "type": "string",
                          "description": "First name.",
                          "maxLength": 262144
                        },
                        "last_name": {
                          "type": "string",
                          "description": "Last name.",
                          "maxLength": 262144
                        },
                        "company": {
                          "type": "string",
                          "description": "Company name.",
                          "maxLength": 262144
                        },
                        "address_1": {
                          "type": "string",
                          "description": "Address line 1",
                          "maxLength": 262144
                        },
                        "address_2": {
                          "type": "string",
                          "description": "Address line 2",
                          "maxLength": 262144
                        },
                        "city": {
                          "type": "string",
                          "description": "City name.",
                          "maxLength": 262144
                        },
                        "state": {
                          "type": "string",
                          "description": "ISO code or name of the state, province or district.",
                          "maxLength": 262144
                        },
                        "postcode": {
                          "type": "string",
                          "description": "Postal code.",
                          "maxLength": 262144
                        },
                        "country": {
                          "type": "string",
                          "description": "Country code in ISO 3166-1 alpha-2 format.",
                          "maxLength": 262144
                        },
                        "email": {
                          "type": [
                            "string",
                            "null"
                          ],
                          "description": "Email address.",
                          "format": "email"
                        },
                        "phone": {
                          "type": "string",
                          "description": "Phone number.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "shipping": {
                      "type": "object",
                      "description": "Shipping address.",
                      "properties": {
                        "first_name": {
                          "type": "string",
                          "description": "First name.",
                          "maxLength": 262144
                        },
                        "last_name": {
                          "type": "string",
                          "description": "Last name.",
                          "maxLength": 262144
                        },
                        "company": {
                          "type": "string",
                          "description": "Company name.",
                          "maxLength": 262144
                        },
                        "address_1": {
                          "type": "string",
                          "description": "Address line 1",
                          "maxLength": 262144
                        },
                        "address_2": {
                          "type": "string",
                          "description": "Address line 2",
                          "maxLength": 262144
                        },
                        "city": {
                          "type": "string",
                          "description": "City name.",
                          "maxLength": 262144
                        },
                        "state": {
                          "type": "string",
                          "description": "ISO code or name of the state, province or district.",
                          "maxLength": 262144
                        },
                        "postcode": {
                          "type": "string",
                          "description": "Postal code.",
                          "maxLength": 262144
                        },
                        "country": {
                          "type": "string",
                          "description": "Country code in ISO 3166-1 alpha-2 format.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "payment_method": {
                      "type": "string",
                      "description": "Payment method ID.",
                      "maxLength": 262144
                    },
                    "payment_method_title": {
                      "type": "string",
                      "description": "Payment method title.",
                      "maxLength": 262144
                    },
                    "transaction_id": {
                      "type": "string",
                      "description": "Unique transaction ID.",
                      "maxLength": 262144
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value.",
                            "items": {},
                            "maxItems": 10
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "line_items": {
                      "type": "array",
                      "description": "Line items data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Item ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "description": "Product name."
                          },
                          "parent_name": {
                            "type": [
                              "string",
                              "null"
                            ],
                            "description": "Parent product name if the product is a variation."
                          },
                          "product_id": {
                            "description": "Product ID."
                          },
                          "variation_id": {
                            "type": "integer",
                            "description": "Variation ID, if applicable.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "quantity": {
                            "type": "integer",
                            "description": "Quantity ordered.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "tax_class": {
                            "type": "string",
                            "description": "Tax class of product.",
                            "maxLength": 262144
                          },
                          "subtotal": {
                            "type": "string",
                            "description": "Line subtotal, excluding tax (before discounts).",
                            "maxLength": 262144
                          },
                          "subtotal_tax": {
                            "type": "string",
                            "description": "Line subtotal tax (before discounts).",
                            "maxLength": 262144
                          },
                          "total": {
                            "type": "string",
                            "description": "Line total, excluding tax (after discounts).",
                            "maxLength": 262144
                          },
                          "total_tax": {
                            "type": "string",
                            "description": "Line total tax (after discounts).",
                            "maxLength": 262144
                          },
                          "taxes": {
                            "type": "array",
                            "description": "Line taxes.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Tax rate ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "total": {
                                  "type": "string",
                                  "description": "Tax total.",
                                  "maxLength": 262144
                                },
                                "subtotal": {
                                  "type": "string",
                                  "description": "Tax subtotal.",
                                  "maxLength": 262144
                                }
                              },
                              "additionalProperties": false
                            },
                            "maxItems": 10
                          },
                          "meta_data": {
                            "type": "array",
                            "description": "Meta data.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Meta ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "key": {
                                  "type": "string",
                                  "description": "Meta key.",
                                  "maxLength": 262144
                                },
                                "value": {
                                  "type": [
                                    "null",
                                    "object",
                                    "string",
                                    "number",
                                    "boolean",
                                    "integer",
                                    "array"
                                  ],
                                  "description": "Meta value.",
                                  "items": {},
                                  "maxItems": 10
                                },
                                "display_key": {
                                  "type": "string",
                                  "description": "Meta key for UI display.",
                                  "maxLength": 262144
                                },
                                "display_value": {
                                  "type": [
                                    "null",
                                    "object",
                                    "string",
                                    "number",
                                    "boolean",
                                    "integer",
                                    "array"
                                  ],
                                  "description": "Meta value for UI display. May be a string or, when mirroring a complex meta value, an array or object.",
                                  "items": {},
                                  "maxItems": 10
                                }
                              },
                              "additionalProperties": false
                            },
                            "maxItems": 10
                          },
                          "sku": {
                            "type": "string",
                            "description": "Product SKU.",
                            "maxLength": 262144
                          },
                          "global_unique_id": {
                            "type": "string",
                            "description": "GTIN, UPC, EAN or ISBN.",
                            "maxLength": 262144
                          },
                          "price": {
                            "type": "number",
                            "description": "Product price."
                          },
                          "image": {
                            "type": "object",
                            "description": "Properties of the main product image.",
                            "properties": {
                              "id": {
                                "type": "integer",
                                "description": "Image ID.",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991
                              },
                              "src": {
                                "type": "string",
                                "description": "Image URL.",
                                "format": "uri",
                                "maxLength": 262144
                              }
                            },
                            "additionalProperties": false
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "shipping_lines": {
                      "type": "array",
                      "description": "Shipping lines data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Item ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "method_title": {
                            "description": "Shipping method name."
                          },
                          "method_id": {
                            "description": "Shipping method ID."
                          },
                          "instance_id": {
                            "type": "string",
                            "description": "Shipping instance ID.",
                            "maxLength": 262144
                          },
                          "total": {
                            "type": "string",
                            "description": "Shipping total, excluding tax.",
                            "maxLength": 262144
                          },
                          "total_tax": {
                            "type": "string",
                            "description": "Shipping total tax.",
                            "maxLength": 262144
                          },
                          "taxes": {
                            "type": "array",
                            "description": "Line taxes.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Tax rate ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "total": {
                                  "type": "string",
                                  "description": "Tax total.",
                                  "maxLength": 262144
                                }
                              },
                              "additionalProperties": false
                            },
                            "maxItems": 10
                          },
                          "meta_data": {
                            "type": "array",
                            "description": "Meta data.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Meta ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "key": {
                                  "type": "string",
                                  "description": "Meta key.",
                                  "maxLength": 262144
                                },
                                "value": {
                                  "type": [
                                    "null",
                                    "object",
                                    "string",
                                    "number",
                                    "boolean",
                                    "integer",
                                    "array"
                                  ],
                                  "description": "Meta value.",
                                  "items": {},
                                  "maxItems": 10
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
                    "fee_lines": {
                      "type": "array",
                      "description": "Fee lines data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Item ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "description": "Fee name."
                          },
                          "tax_class": {
                            "type": "string",
                            "description": "Tax class of fee.",
                            "maxLength": 262144
                          },
                          "tax_status": {
                            "type": "string",
                            "enum": [
                              "taxable",
                              "none"
                            ],
                            "description": "Tax status of fee.",
                            "maxLength": 262144
                          },
                          "total": {
                            "type": "string",
                            "description": "Fee total, excluding tax.",
                            "maxLength": 262144
                          },
                          "total_tax": {
                            "type": "string",
                            "description": "Fee total tax.",
                            "maxLength": 262144
                          },
                          "taxes": {
                            "type": "array",
                            "description": "Line taxes.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Tax rate ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "total": {
                                  "type": "string",
                                  "description": "Tax total.",
                                  "maxLength": 262144
                                },
                                "subtotal": {
                                  "type": "string",
                                  "description": "Tax subtotal.",
                                  "maxLength": 262144
                                }
                              },
                              "additionalProperties": false
                            },
                            "maxItems": 10
                          },
                          "meta_data": {
                            "type": "array",
                            "description": "Meta data.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Meta ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "key": {
                                  "type": "string",
                                  "description": "Meta key.",
                                  "maxLength": 262144
                                },
                                "value": {
                                  "type": [
                                    "null",
                                    "object",
                                    "string",
                                    "number",
                                    "boolean",
                                    "integer",
                                    "array"
                                  ],
                                  "description": "Meta value.",
                                  "items": {},
                                  "maxItems": 10
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
                    "coupon_lines": {
                      "type": "array",
                      "description": "Coupons line data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Item ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "code": {
                            "description": "Coupon code."
                          },
                          "discount": {
                            "type": "string",
                            "description": "Discount total.",
                            "maxLength": 262144
                          },
                          "discount_tax": {
                            "type": "string",
                            "description": "Discount total tax.",
                            "maxLength": 262144
                          },
                          "discount_type": {
                            "type": "string",
                            "description": "Discount type.",
                            "maxLength": 262144
                          },
                          "nominal_amount": {
                            "type": "number",
                            "description": "Discount amount as defined in the coupon (absolute value or a percent, depending on the discount type)."
                          },
                          "free_shipping": {
                            "type": "boolean",
                            "description": "Whether the coupon grants free shipping or not."
                          },
                          "meta_data": {
                            "type": "array",
                            "description": "Meta data.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Meta ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "key": {
                                  "type": "string",
                                  "description": "Meta key.",
                                  "maxLength": 262144
                                },
                                "value": {
                                  "type": [
                                    "null",
                                    "object",
                                    "string",
                                    "number",
                                    "boolean",
                                    "integer",
                                    "array"
                                  ],
                                  "description": "Meta value.",
                                  "items": {},
                                  "maxItems": 10
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
                    "set_paid": {
                      "type": "boolean",
                      "description": "Define if the order is paid. It will set the status to processing and reduce stock items."
                    },
                    "manual_update": {
                      "type": "boolean",
                      "description": "Set the action as manual so that the order note registers as \"added by user\"."
                    }
                  },
                  "additionalProperties": false,
                  "required": []
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "parent_id": {
                      "type": "integer",
                      "description": "Parent order ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "created_via": {
                      "type": "string",
                      "description": "Shows where the order was created.",
                      "maxLength": 262144
                    },
                    "status": {
                      "type": "string",
                      "description": "Order status.",
                      "maxLength": 262144
                    },
                    "currency": {
                      "type": "string",
                      "description": "Currency the order was created with, in ISO format.",
                      "maxLength": 262144
                    },
                    "customer_id": {
                      "type": "integer",
                      "description": "User ID who owns the order. 0 for guests.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "customer_note": {
                      "type": "string",
                      "description": "Note left by customer during checkout.",
                      "maxLength": 262144
                    },
                    "billing": {
                      "type": "object",
                      "description": "Billing address.",
                      "properties": {
                        "first_name": {
                          "type": "string",
                          "description": "First name.",
                          "maxLength": 262144
                        },
                        "last_name": {
                          "type": "string",
                          "description": "Last name.",
                          "maxLength": 262144
                        },
                        "company": {
                          "type": "string",
                          "description": "Company name.",
                          "maxLength": 262144
                        },
                        "address_1": {
                          "type": "string",
                          "description": "Address line 1",
                          "maxLength": 262144
                        },
                        "address_2": {
                          "type": "string",
                          "description": "Address line 2",
                          "maxLength": 262144
                        },
                        "city": {
                          "type": "string",
                          "description": "City name.",
                          "maxLength": 262144
                        },
                        "state": {
                          "type": "string",
                          "description": "ISO code or name of the state, province or district.",
                          "maxLength": 262144
                        },
                        "postcode": {
                          "type": "string",
                          "description": "Postal code.",
                          "maxLength": 262144
                        },
                        "country": {
                          "type": "string",
                          "description": "Country code in ISO 3166-1 alpha-2 format.",
                          "maxLength": 262144
                        },
                        "email": {
                          "type": [
                            "string",
                            "null"
                          ],
                          "description": "Email address.",
                          "format": "email"
                        },
                        "phone": {
                          "type": "string",
                          "description": "Phone number.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "shipping": {
                      "type": "object",
                      "description": "Shipping address.",
                      "properties": {
                        "first_name": {
                          "type": "string",
                          "description": "First name.",
                          "maxLength": 262144
                        },
                        "last_name": {
                          "type": "string",
                          "description": "Last name.",
                          "maxLength": 262144
                        },
                        "company": {
                          "type": "string",
                          "description": "Company name.",
                          "maxLength": 262144
                        },
                        "address_1": {
                          "type": "string",
                          "description": "Address line 1",
                          "maxLength": 262144
                        },
                        "address_2": {
                          "type": "string",
                          "description": "Address line 2",
                          "maxLength": 262144
                        },
                        "city": {
                          "type": "string",
                          "description": "City name.",
                          "maxLength": 262144
                        },
                        "state": {
                          "type": "string",
                          "description": "ISO code or name of the state, province or district.",
                          "maxLength": 262144
                        },
                        "postcode": {
                          "type": "string",
                          "description": "Postal code.",
                          "maxLength": 262144
                        },
                        "country": {
                          "type": "string",
                          "description": "Country code in ISO 3166-1 alpha-2 format.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "payment_method": {
                      "type": "string",
                      "description": "Payment method ID.",
                      "maxLength": 262144
                    },
                    "payment_method_title": {
                      "type": "string",
                      "description": "Payment method title.",
                      "maxLength": 262144
                    },
                    "transaction_id": {
                      "type": "string",
                      "description": "Unique transaction ID.",
                      "maxLength": 262144
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "type": [
                              "null",
                              "object",
                              "string",
                              "number",
                              "boolean",
                              "integer",
                              "array"
                            ],
                            "description": "Meta value.",
                            "items": {},
                            "maxItems": 10
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "line_items": {
                      "type": "array",
                      "description": "Line items data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Item ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "description": "Product name."
                          },
                          "parent_name": {
                            "type": [
                              "string",
                              "null"
                            ],
                            "description": "Parent product name if the product is a variation."
                          },
                          "product_id": {
                            "description": "Product ID."
                          },
                          "variation_id": {
                            "type": "integer",
                            "description": "Variation ID, if applicable.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "quantity": {
                            "type": "integer",
                            "description": "Quantity ordered.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "tax_class": {
                            "type": "string",
                            "description": "Tax class of product.",
                            "maxLength": 262144
                          },
                          "subtotal": {
                            "type": "string",
                            "description": "Line subtotal, excluding tax (before discounts).",
                            "maxLength": 262144
                          },
                          "subtotal_tax": {
                            "type": "string",
                            "description": "Line subtotal tax (before discounts).",
                            "maxLength": 262144
                          },
                          "total": {
                            "type": "string",
                            "description": "Line total, excluding tax (after discounts).",
                            "maxLength": 262144
                          },
                          "total_tax": {
                            "type": "string",
                            "description": "Line total tax (after discounts).",
                            "maxLength": 262144
                          },
                          "taxes": {
                            "type": "array",
                            "description": "Line taxes.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Tax rate ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "total": {
                                  "type": "string",
                                  "description": "Tax total.",
                                  "maxLength": 262144
                                },
                                "subtotal": {
                                  "type": "string",
                                  "description": "Tax subtotal.",
                                  "maxLength": 262144
                                }
                              },
                              "additionalProperties": false
                            },
                            "maxItems": 10
                          },
                          "meta_data": {
                            "type": "array",
                            "description": "Meta data.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Meta ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "key": {
                                  "type": "string",
                                  "description": "Meta key.",
                                  "maxLength": 262144
                                },
                                "value": {
                                  "type": [
                                    "null",
                                    "object",
                                    "string",
                                    "number",
                                    "boolean",
                                    "integer",
                                    "array"
                                  ],
                                  "description": "Meta value.",
                                  "items": {},
                                  "maxItems": 10
                                },
                                "display_key": {
                                  "type": "string",
                                  "description": "Meta key for UI display.",
                                  "maxLength": 262144
                                },
                                "display_value": {
                                  "type": [
                                    "null",
                                    "object",
                                    "string",
                                    "number",
                                    "boolean",
                                    "integer",
                                    "array"
                                  ],
                                  "description": "Meta value for UI display. May be a string or, when mirroring a complex meta value, an array or object.",
                                  "items": {},
                                  "maxItems": 10
                                }
                              },
                              "additionalProperties": false
                            },
                            "maxItems": 10
                          },
                          "sku": {
                            "type": "string",
                            "description": "Product SKU.",
                            "maxLength": 262144
                          },
                          "global_unique_id": {
                            "type": "string",
                            "description": "GTIN, UPC, EAN or ISBN.",
                            "maxLength": 262144
                          },
                          "price": {
                            "type": "number",
                            "description": "Product price."
                          },
                          "image": {
                            "type": "object",
                            "description": "Properties of the main product image.",
                            "properties": {
                              "id": {
                                "type": "integer",
                                "description": "Image ID.",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991
                              },
                              "src": {
                                "type": "string",
                                "description": "Image URL.",
                                "format": "uri",
                                "maxLength": 262144
                              }
                            },
                            "additionalProperties": false
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "shipping_lines": {
                      "type": "array",
                      "description": "Shipping lines data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Item ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "method_title": {
                            "description": "Shipping method name."
                          },
                          "method_id": {
                            "description": "Shipping method ID."
                          },
                          "instance_id": {
                            "type": "string",
                            "description": "Shipping instance ID.",
                            "maxLength": 262144
                          },
                          "total": {
                            "type": "string",
                            "description": "Shipping total, excluding tax.",
                            "maxLength": 262144
                          },
                          "total_tax": {
                            "type": "string",
                            "description": "Shipping total tax.",
                            "maxLength": 262144
                          },
                          "taxes": {
                            "type": "array",
                            "description": "Line taxes.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Tax rate ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "total": {
                                  "type": "string",
                                  "description": "Tax total.",
                                  "maxLength": 262144
                                }
                              },
                              "additionalProperties": false
                            },
                            "maxItems": 10
                          },
                          "meta_data": {
                            "type": "array",
                            "description": "Meta data.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Meta ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "key": {
                                  "type": "string",
                                  "description": "Meta key.",
                                  "maxLength": 262144
                                },
                                "value": {
                                  "type": [
                                    "null",
                                    "object",
                                    "string",
                                    "number",
                                    "boolean",
                                    "integer",
                                    "array"
                                  ],
                                  "description": "Meta value.",
                                  "items": {},
                                  "maxItems": 10
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
                    "fee_lines": {
                      "type": "array",
                      "description": "Fee lines data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Item ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "name": {
                            "description": "Fee name."
                          },
                          "tax_class": {
                            "type": "string",
                            "description": "Tax class of fee.",
                            "maxLength": 262144
                          },
                          "tax_status": {
                            "type": "string",
                            "enum": [
                              "taxable",
                              "none"
                            ],
                            "description": "Tax status of fee.",
                            "maxLength": 262144
                          },
                          "total": {
                            "type": "string",
                            "description": "Fee total, excluding tax.",
                            "maxLength": 262144
                          },
                          "total_tax": {
                            "type": "string",
                            "description": "Fee total tax.",
                            "maxLength": 262144
                          },
                          "taxes": {
                            "type": "array",
                            "description": "Line taxes.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Tax rate ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "total": {
                                  "type": "string",
                                  "description": "Tax total.",
                                  "maxLength": 262144
                                },
                                "subtotal": {
                                  "type": "string",
                                  "description": "Tax subtotal.",
                                  "maxLength": 262144
                                }
                              },
                              "additionalProperties": false
                            },
                            "maxItems": 10
                          },
                          "meta_data": {
                            "type": "array",
                            "description": "Meta data.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Meta ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "key": {
                                  "type": "string",
                                  "description": "Meta key.",
                                  "maxLength": 262144
                                },
                                "value": {
                                  "type": [
                                    "null",
                                    "object",
                                    "string",
                                    "number",
                                    "boolean",
                                    "integer",
                                    "array"
                                  ],
                                  "description": "Meta value.",
                                  "items": {},
                                  "maxItems": 10
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
                    "coupon_lines": {
                      "type": "array",
                      "description": "Coupons line data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Item ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "code": {
                            "description": "Coupon code."
                          },
                          "discount": {
                            "type": "string",
                            "description": "Discount total.",
                            "maxLength": 262144
                          },
                          "discount_tax": {
                            "type": "string",
                            "description": "Discount total tax.",
                            "maxLength": 262144
                          },
                          "discount_type": {
                            "type": "string",
                            "description": "Discount type.",
                            "maxLength": 262144
                          },
                          "nominal_amount": {
                            "type": "number",
                            "description": "Discount amount as defined in the coupon (absolute value or a percent, depending on the discount type)."
                          },
                          "free_shipping": {
                            "type": "boolean",
                            "description": "Whether the coupon grants free shipping or not."
                          },
                          "meta_data": {
                            "type": "array",
                            "description": "Meta data.",
                            "items": {
                              "type": "object",
                              "properties": {
                                "id": {
                                  "type": "integer",
                                  "description": "Meta ID.",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991
                                },
                                "key": {
                                  "type": "string",
                                  "description": "Meta key.",
                                  "maxLength": 262144
                                },
                                "value": {
                                  "type": [
                                    "null",
                                    "object",
                                    "string",
                                    "number",
                                    "boolean",
                                    "integer",
                                    "array"
                                  ],
                                  "description": "Meta value.",
                                  "items": {},
                                  "maxItems": 10
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
                    "set_paid": {
                      "type": "boolean",
                      "description": "Define if the order is paid. It will set the status to processing and reduce stock items."
                    },
                    "manual_update": {
                      "type": "boolean",
                      "description": "Set the action as manual so that the order note registers as \"added by user\"."
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /orders/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /orders/{order_id}/notes": {
      "method": "GET",
      "path": "/orders/{order_id}/notes",
      "risk": "R",
      "resource": "orders/{order_id}/notes",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "type": {
                "type": "string",
                "enum": [
                  "any",
                  "customer",
                  "internal"
                ],
                "description": "Limit result to customers or internal notes.",
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
      "ack_key": null,
      "description": "GET /orders/{order_id}/notes — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /orders/{order_id}/notes": {
      "method": "POST",
      "path": "/orders/{order_id}/notes",
      "risk": "H",
      "resource": "orders/{order_id}/notes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "note": {
                "type": "string",
                "description": "Order note content.",
                "maxLength": 262144
              },
              "customer_note": {
                "type": "boolean",
                "description": "If true, the note will be shown to customers and they will be notified. If false, the note will be for admin reference only."
              },
              "added_by_user": {
                "type": "boolean",
                "description": "If true, this note will be attributed to the current user. If false, the note will be attributed to the system."
              }
            },
            "additionalProperties": false,
            "required": [
              "note"
            ]
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /orders/{order_id}/notes — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /orders/{order_id}/notes/{id}": {
      "method": "GET",
      "path": "/orders/{order_id}/notes/{id}",
      "risk": "R",
      "resource": "orders/{order_id}/notes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "order_id",
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /orders/{order_id}/notes/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "DELETE /orders/{order_id}/notes/{id}": {
      "method": "DELETE",
      "path": "/orders/{order_id}/notes/{id}",
      "risk": "D",
      "resource": "orders/{order_id}/notes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "order_id",
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Required to be true, as resource does not support trashing."
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
      "ack_key": "id",
      "description": "DELETE /orders/{order_id}/notes/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /orders/{order_id}/refunds": {
      "method": "GET",
      "path": "/orders/{order_id}/refunds",
      "risk": "R",
      "resource": "orders/{order_id}/refunds",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "description": "Current page of the collection.",
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Maximum number of items to be returned in result set."
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "after": {
                "type": "string",
                "description": "Limit response to resources published after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "before": {
                "type": "string",
                "description": "Limit response to resources published before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "date",
                  "id",
                  "include",
                  "title",
                  "slug",
                  "modified"
                ],
                "description": "Sort collection by object attribute.",
                "maxLength": 262144
              },
              "parent": {
                "type": "array",
                "description": "Limit result set to those of particular parent IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "parent_exclude": {
                "type": "array",
                "description": "Limit result set to all items except those of a particular parent ID.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "dp": {
                "type": "integer",
                "description": "Number of decimal points to use in each resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "modified_after": {
                "type": "string",
                "description": "Limit response to resources modified after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "modified_before": {
                "type": "string",
                "description": "Limit response to resources modified before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "dates_are_gmt": {
                "type": "boolean",
                "description": "Whether to consider GMT post dates when limiting response by published or modified date."
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
      "ack_key": null,
      "description": "GET /orders/{order_id}/refunds — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /orders/{order_id}/refunds": {
      "method": "POST",
      "path": "/orders/{order_id}/refunds",
      "risk": "H",
      "resource": "orders/{order_id}/refunds",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "amount": {
                "type": "string",
                "description": "Refund amount.",
                "maxLength": 262144
              },
              "reason": {
                "type": "string",
                "description": "Reason for refund.",
                "maxLength": 262144
              },
              "refunded_by": {
                "type": "integer",
                "description": "User ID of user who created the refund.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "description": "Meta value."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "shipping_lines": {
                "type": "array",
                "description": "Shipping lines data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Item ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "method_title": {
                      "description": "Shipping method name."
                    },
                    "method_id": {
                      "description": "Shipping method ID."
                    },
                    "instance_id": {
                      "type": "string",
                      "description": "Shipping instance ID.",
                      "maxLength": 262144
                    },
                    "total": {
                      "type": "string",
                      "description": "Line total (after discounts).",
                      "maxLength": 262144
                    },
                    "total_tax": {
                      "type": "string",
                      "description": "Line total tax (after discounts).",
                      "maxLength": 262144
                    },
                    "taxes": {
                      "type": "array",
                      "description": "Line taxes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Tax rate ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "total": {
                            "type": "string",
                            "description": "Tax total.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "description": "Meta value."
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
              "fee_lines": {
                "type": "array",
                "description": "Fee lines data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Item ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "description": "Fee name."
                    },
                    "tax_class": {
                      "type": "string",
                      "description": "Tax class of fee.",
                      "maxLength": 262144
                    },
                    "tax_status": {
                      "type": "string",
                      "description": "Tax status of fee.",
                      "maxLength": 262144
                    },
                    "total": {
                      "type": "string",
                      "description": "Line total (after discounts).",
                      "maxLength": 262144
                    },
                    "total_tax": {
                      "type": "string",
                      "description": "Line total tax (after discounts).",
                      "maxLength": 262144
                    },
                    "taxes": {
                      "type": "array",
                      "description": "Line taxes.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Tax rate ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "total": {
                            "type": "string",
                            "description": "Tax total.",
                            "maxLength": 262144
                          },
                          "subtotal": {
                            "type": "string",
                            "description": "Tax subtotal.",
                            "maxLength": 262144
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "description": "Meta value."
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
              "api_refund": {
                "type": "boolean",
                "description": "When true, the payment gateway API is used to generate the refund."
              },
              "api_restock": {
                "type": "boolean",
                "description": "When true, refunded items are restocked."
              },
              "compute_totals": {
                "type": "boolean",
                "description": "When true, the server computes per-line refund amounts from quantities using the order's stored prices and taxes, validating the request against the order's refund history. Defaults to false, which preserves the pre-existing behavior of this endpoint."
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /orders/{order_id}/refunds — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /orders/{order_id}/refunds/{id}": {
      "method": "GET",
      "path": "/orders/{order_id}/refunds/{id}",
      "risk": "R",
      "resource": "orders/{order_id}/refunds",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "order_id",
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /orders/{order_id}/refunds/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "DELETE /orders/{order_id}/refunds/{id}": {
      "method": "DELETE",
      "path": "/orders/{order_id}/refunds/{id}",
      "risk": "D",
      "resource": "orders/{order_id}/refunds",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "order_id",
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Required to be true, as resource does not support trashing."
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
      "ack_key": "id",
      "description": "DELETE /orders/{order_id}/refunds/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /customers": {
      "method": "GET",
      "path": "/customers",
      "risk": "R",
      "resource": "customers",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "description": "Current page of the collection.",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "description": "Maximum number of items to be returned in result set.",
                "minimum": 1,
                "maximum": 100
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "id",
                  "include",
                  "name",
                  "registered_date"
                ],
                "description": "Sort collection by object attribute.",
                "maxLength": 262144
              },
              "email": {
                "type": "string",
                "description": "Limit result set to resources with a specific email.",
                "format": "email",
                "maxLength": 262144
              },
              "role": {
                "type": "string",
                "description": "Limit result set to resources with a specific role.",
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
      "ack_key": null,
      "description": "GET /customers — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /customers": {
      "method": "POST",
      "path": "/customers",
      "risk": "W",
      "resource": "customers",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "email": {
                "type": "string",
                "description": "The email address for the customer.",
                "format": "email",
                "maxLength": 262144
              },
              "first_name": {
                "type": "string",
                "description": "Customer first name.",
                "maxLength": 262144
              },
              "last_name": {
                "type": "string",
                "description": "Customer last name.",
                "maxLength": 262144
              },
              "username": {
                "type": "string",
                "description": "Customer login name.",
                "maxLength": 262144
              },
              "password": {
                "type": "string",
                "description": "Customer password.",
                "maxLength": 262144
              },
              "billing": {
                "type": "object",
                "description": "List of billing address data.",
                "properties": {
                  "first_name": {
                    "type": "string",
                    "description": "First name.",
                    "maxLength": 262144
                  },
                  "last_name": {
                    "type": "string",
                    "description": "Last name.",
                    "maxLength": 262144
                  },
                  "company": {
                    "type": "string",
                    "description": "Company name.",
                    "maxLength": 262144
                  },
                  "address_1": {
                    "type": "string",
                    "description": "Address line 1",
                    "maxLength": 262144
                  },
                  "address_2": {
                    "type": "string",
                    "description": "Address line 2",
                    "maxLength": 262144
                  },
                  "city": {
                    "type": "string",
                    "description": "City name.",
                    "maxLength": 262144
                  },
                  "state": {
                    "type": "string",
                    "description": "ISO code or name of the state, province or district.",
                    "maxLength": 262144
                  },
                  "postcode": {
                    "type": "string",
                    "description": "Postal code.",
                    "maxLength": 262144
                  },
                  "country": {
                    "type": "string",
                    "description": "ISO code of the country.",
                    "maxLength": 262144
                  },
                  "email": {
                    "type": "string",
                    "description": "Email address.",
                    "format": "email",
                    "maxLength": 262144
                  },
                  "phone": {
                    "type": "string",
                    "description": "Phone number.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "shipping": {
                "type": "object",
                "description": "List of shipping address data.",
                "properties": {
                  "first_name": {
                    "type": "string",
                    "description": "First name.",
                    "maxLength": 262144
                  },
                  "last_name": {
                    "type": "string",
                    "description": "Last name.",
                    "maxLength": 262144
                  },
                  "company": {
                    "type": "string",
                    "description": "Company name.",
                    "maxLength": 262144
                  },
                  "address_1": {
                    "type": "string",
                    "description": "Address line 1",
                    "maxLength": 262144
                  },
                  "address_2": {
                    "type": "string",
                    "description": "Address line 2",
                    "maxLength": 262144
                  },
                  "city": {
                    "type": "string",
                    "description": "City name.",
                    "maxLength": 262144
                  },
                  "state": {
                    "type": "string",
                    "description": "ISO code or name of the state, province or district.",
                    "maxLength": 262144
                  },
                  "postcode": {
                    "type": "string",
                    "description": "Postal code.",
                    "maxLength": 262144
                  },
                  "country": {
                    "type": "string",
                    "description": "ISO code of the country.",
                    "maxLength": 262144
                  },
                  "phone": {
                    "type": "string",
                    "description": "Phone number.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "description": "Meta value."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 25
              }
            },
            "additionalProperties": false,
            "required": [
              "email"
            ]
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /customers — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /customers/{id}": {
      "method": "GET",
      "path": "/customers/{id}",
      "risk": "R",
      "resource": "customers",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /customers/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /customers/{id}": {
      "method": "PUT",
      "path": "/customers/{id}",
      "risk": "W",
      "resource": "customers",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "email": {
                "type": "string",
                "description": "The email address for the customer.",
                "format": "email",
                "maxLength": 262144
              },
              "first_name": {
                "type": "string",
                "description": "Customer first name.",
                "maxLength": 262144
              },
              "last_name": {
                "type": "string",
                "description": "Customer last name.",
                "maxLength": 262144
              },
              "username": {
                "type": "string",
                "description": "Customer login name.",
                "maxLength": 262144
              },
              "password": {
                "type": "string",
                "description": "Customer password.",
                "maxLength": 262144
              },
              "billing": {
                "type": "object",
                "description": "List of billing address data.",
                "properties": {
                  "first_name": {
                    "type": "string",
                    "description": "First name.",
                    "maxLength": 262144
                  },
                  "last_name": {
                    "type": "string",
                    "description": "Last name.",
                    "maxLength": 262144
                  },
                  "company": {
                    "type": "string",
                    "description": "Company name.",
                    "maxLength": 262144
                  },
                  "address_1": {
                    "type": "string",
                    "description": "Address line 1",
                    "maxLength": 262144
                  },
                  "address_2": {
                    "type": "string",
                    "description": "Address line 2",
                    "maxLength": 262144
                  },
                  "city": {
                    "type": "string",
                    "description": "City name.",
                    "maxLength": 262144
                  },
                  "state": {
                    "type": "string",
                    "description": "ISO code or name of the state, province or district.",
                    "maxLength": 262144
                  },
                  "postcode": {
                    "type": "string",
                    "description": "Postal code.",
                    "maxLength": 262144
                  },
                  "country": {
                    "type": "string",
                    "description": "ISO code of the country.",
                    "maxLength": 262144
                  },
                  "email": {
                    "type": "string",
                    "description": "Email address.",
                    "format": "email",
                    "maxLength": 262144
                  },
                  "phone": {
                    "type": "string",
                    "description": "Phone number.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "shipping": {
                "type": "object",
                "description": "List of shipping address data.",
                "properties": {
                  "first_name": {
                    "type": "string",
                    "description": "First name.",
                    "maxLength": 262144
                  },
                  "last_name": {
                    "type": "string",
                    "description": "Last name.",
                    "maxLength": 262144
                  },
                  "company": {
                    "type": "string",
                    "description": "Company name.",
                    "maxLength": 262144
                  },
                  "address_1": {
                    "type": "string",
                    "description": "Address line 1",
                    "maxLength": 262144
                  },
                  "address_2": {
                    "type": "string",
                    "description": "Address line 2",
                    "maxLength": 262144
                  },
                  "city": {
                    "type": "string",
                    "description": "City name.",
                    "maxLength": 262144
                  },
                  "state": {
                    "type": "string",
                    "description": "ISO code or name of the state, province or district.",
                    "maxLength": 262144
                  },
                  "postcode": {
                    "type": "string",
                    "description": "Postal code.",
                    "maxLength": 262144
                  },
                  "country": {
                    "type": "string",
                    "description": "ISO code of the country.",
                    "maxLength": 262144
                  },
                  "phone": {
                    "type": "string",
                    "description": "Phone number.",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "description": "Meta value."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 25
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /customers/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /customers/{id}": {
      "method": "DELETE",
      "path": "/customers/{id}",
      "risk": "D",
      "resource": "customers",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Required to be true, as resource does not support trashing."
              },
              "reassign": {
                "type": "integer",
                "description": "ID to reassign posts to.",
                "minimum": -9007199254740991,
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
      "ack_key": "id",
      "description": "DELETE /customers/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /customers/batch": {
      "method": "POST",
      "path": "/customers/batch",
      "risk": "D",
      "resource": "customers",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "email": {
                      "type": "string",
                      "description": "The email address for the customer.",
                      "format": "email",
                      "maxLength": 262144
                    },
                    "first_name": {
                      "type": "string",
                      "description": "Customer first name.",
                      "maxLength": 262144
                    },
                    "last_name": {
                      "type": "string",
                      "description": "Customer last name.",
                      "maxLength": 262144
                    },
                    "username": {
                      "type": "string",
                      "description": "Customer login name.",
                      "maxLength": 262144
                    },
                    "password": {
                      "type": "string",
                      "description": "Customer password.",
                      "maxLength": 262144
                    },
                    "billing": {
                      "type": "object",
                      "description": "List of billing address data.",
                      "properties": {
                        "first_name": {
                          "type": "string",
                          "description": "First name.",
                          "maxLength": 262144
                        },
                        "last_name": {
                          "type": "string",
                          "description": "Last name.",
                          "maxLength": 262144
                        },
                        "company": {
                          "type": "string",
                          "description": "Company name.",
                          "maxLength": 262144
                        },
                        "address_1": {
                          "type": "string",
                          "description": "Address line 1",
                          "maxLength": 262144
                        },
                        "address_2": {
                          "type": "string",
                          "description": "Address line 2",
                          "maxLength": 262144
                        },
                        "city": {
                          "type": "string",
                          "description": "City name.",
                          "maxLength": 262144
                        },
                        "state": {
                          "type": "string",
                          "description": "ISO code or name of the state, province or district.",
                          "maxLength": 262144
                        },
                        "postcode": {
                          "type": "string",
                          "description": "Postal code.",
                          "maxLength": 262144
                        },
                        "country": {
                          "type": "string",
                          "description": "ISO code of the country.",
                          "maxLength": 262144
                        },
                        "email": {
                          "type": "string",
                          "description": "Email address.",
                          "format": "email",
                          "maxLength": 262144
                        },
                        "phone": {
                          "type": "string",
                          "description": "Phone number.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "shipping": {
                      "type": "object",
                      "description": "List of shipping address data.",
                      "properties": {
                        "first_name": {
                          "type": "string",
                          "description": "First name.",
                          "maxLength": 262144
                        },
                        "last_name": {
                          "type": "string",
                          "description": "Last name.",
                          "maxLength": 262144
                        },
                        "company": {
                          "type": "string",
                          "description": "Company name.",
                          "maxLength": 262144
                        },
                        "address_1": {
                          "type": "string",
                          "description": "Address line 1",
                          "maxLength": 262144
                        },
                        "address_2": {
                          "type": "string",
                          "description": "Address line 2",
                          "maxLength": 262144
                        },
                        "city": {
                          "type": "string",
                          "description": "City name.",
                          "maxLength": 262144
                        },
                        "state": {
                          "type": "string",
                          "description": "ISO code or name of the state, province or district.",
                          "maxLength": 262144
                        },
                        "postcode": {
                          "type": "string",
                          "description": "Postal code.",
                          "maxLength": 262144
                        },
                        "country": {
                          "type": "string",
                          "description": "ISO code of the country.",
                          "maxLength": 262144
                        },
                        "phone": {
                          "type": "string",
                          "description": "Phone number.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "description": "Meta value."
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "email"
                  ]
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "email": {
                      "type": "string",
                      "description": "The email address for the customer.",
                      "format": "email",
                      "maxLength": 262144
                    },
                    "first_name": {
                      "type": "string",
                      "description": "Customer first name.",
                      "maxLength": 262144
                    },
                    "last_name": {
                      "type": "string",
                      "description": "Customer last name.",
                      "maxLength": 262144
                    },
                    "username": {
                      "type": "string",
                      "description": "Customer login name.",
                      "maxLength": 262144
                    },
                    "password": {
                      "type": "string",
                      "description": "Customer password.",
                      "maxLength": 262144
                    },
                    "billing": {
                      "type": "object",
                      "description": "List of billing address data.",
                      "properties": {
                        "first_name": {
                          "type": "string",
                          "description": "First name.",
                          "maxLength": 262144
                        },
                        "last_name": {
                          "type": "string",
                          "description": "Last name.",
                          "maxLength": 262144
                        },
                        "company": {
                          "type": "string",
                          "description": "Company name.",
                          "maxLength": 262144
                        },
                        "address_1": {
                          "type": "string",
                          "description": "Address line 1",
                          "maxLength": 262144
                        },
                        "address_2": {
                          "type": "string",
                          "description": "Address line 2",
                          "maxLength": 262144
                        },
                        "city": {
                          "type": "string",
                          "description": "City name.",
                          "maxLength": 262144
                        },
                        "state": {
                          "type": "string",
                          "description": "ISO code or name of the state, province or district.",
                          "maxLength": 262144
                        },
                        "postcode": {
                          "type": "string",
                          "description": "Postal code.",
                          "maxLength": 262144
                        },
                        "country": {
                          "type": "string",
                          "description": "ISO code of the country.",
                          "maxLength": 262144
                        },
                        "email": {
                          "type": "string",
                          "description": "Email address.",
                          "format": "email",
                          "maxLength": 262144
                        },
                        "phone": {
                          "type": "string",
                          "description": "Phone number.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "shipping": {
                      "type": "object",
                      "description": "List of shipping address data.",
                      "properties": {
                        "first_name": {
                          "type": "string",
                          "description": "First name.",
                          "maxLength": 262144
                        },
                        "last_name": {
                          "type": "string",
                          "description": "Last name.",
                          "maxLength": 262144
                        },
                        "company": {
                          "type": "string",
                          "description": "Company name.",
                          "maxLength": 262144
                        },
                        "address_1": {
                          "type": "string",
                          "description": "Address line 1",
                          "maxLength": 262144
                        },
                        "address_2": {
                          "type": "string",
                          "description": "Address line 2",
                          "maxLength": 262144
                        },
                        "city": {
                          "type": "string",
                          "description": "City name.",
                          "maxLength": 262144
                        },
                        "state": {
                          "type": "string",
                          "description": "ISO code or name of the state, province or district.",
                          "maxLength": 262144
                        },
                        "postcode": {
                          "type": "string",
                          "description": "Postal code.",
                          "maxLength": 262144
                        },
                        "country": {
                          "type": "string",
                          "description": "ISO code of the country.",
                          "maxLength": 262144
                        },
                        "phone": {
                          "type": "string",
                          "description": "Phone number.",
                          "maxLength": 262144
                        }
                      },
                      "additionalProperties": false
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "description": "Meta value."
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /customers/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /coupons": {
      "method": "GET",
      "path": "/coupons",
      "risk": "R",
      "resource": "coupons",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "description": "Current page of the collection.",
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Maximum number of items to be returned in result set."
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "after": {
                "type": "string",
                "description": "Limit response to resources published after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "before": {
                "type": "string",
                "description": "Limit response to resources published before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "date",
                  "id",
                  "include",
                  "title",
                  "slug",
                  "modified"
                ],
                "description": "Sort collection by object attribute.",
                "maxLength": 262144
              },
              "code": {
                "type": "string",
                "description": "Limit result set to resources with a specific code.",
                "maxLength": 262144
              },
              "modified_after": {
                "type": "string",
                "description": "Limit response to resources modified after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "modified_before": {
                "type": "string",
                "description": "Limit response to resources modified before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "dates_are_gmt": {
                "type": "boolean",
                "description": "Whether to consider GMT post dates when limiting response by published or modified date."
              },
              "parent": {
                "type": "array",
                "description": "Limit result set to those of particular parent IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "parent_exclude": {
                "type": "array",
                "description": "Limit result set to all items except those of a particular parent ID.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
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
      "ack_key": null,
      "description": "GET /coupons — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /coupons": {
      "method": "POST",
      "path": "/coupons",
      "risk": "H",
      "resource": "coupons",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "code": {
                "type": "string",
                "description": "Coupon code.",
                "maxLength": 262144
              },
              "amount": {
                "type": [
                  "number",
                  "string"
                ],
                "description": "The amount of discount. Should always be numeric, even if setting a percentage."
              },
              "status": {
                "type": "string",
                "description": "The status of the coupon. Should always be draft, published, or pending review",
                "maxLength": 262144
              },
              "discount_type": {
                "type": "string",
                "description": "Determines the type of discount that will be applied.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "Coupon description.",
                "maxLength": 262144
              },
              "date_expires": {
                "type": "string",
                "description": "The date the coupon expires, in the site's timezone.",
                "maxLength": 262144
              },
              "date_expires_gmt": {
                "type": "string",
                "description": "The date the coupon expires, as GMT.",
                "maxLength": 262144
              },
              "individual_use": {
                "type": "boolean",
                "description": "If true, the coupon can only be used individually. Other applied coupons will be removed from the cart."
              },
              "product_ids": {
                "type": "array",
                "description": "List of product IDs the coupon can be used on.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "excluded_product_ids": {
                "type": "array",
                "description": "List of product IDs the coupon cannot be used on.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "usage_limit": {
                "type": "integer",
                "description": "How many times the coupon can be used in total.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "usage_limit_per_user": {
                "type": "integer",
                "description": "How many times the coupon can be used per customer.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "limit_usage_to_x_items": {
                "type": "integer",
                "description": "Max number of items in the cart the coupon can be applied to.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "free_shipping": {
                "type": "boolean",
                "description": "If true and if the free shipping method requires a coupon, this coupon will enable free shipping."
              },
              "product_categories": {
                "type": "array",
                "description": "List of category IDs the coupon applies to.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "excluded_product_categories": {
                "type": "array",
                "description": "List of category IDs the coupon does not apply to.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "exclude_sale_items": {
                "type": "boolean",
                "description": "If true, this coupon will not be applied to items that have sale prices."
              },
              "minimum_amount": {
                "type": [
                  "number",
                  "string"
                ],
                "description": "Minimum order amount that needs to be in the cart before coupon applies."
              },
              "maximum_amount": {
                "type": [
                  "number",
                  "string"
                ],
                "description": "Maximum order amount allowed when using the coupon."
              },
              "email_restrictions": {
                "type": "array",
                "description": "List of email addresses that can use this coupon.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "description": "Meta value."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false,
            "required": [
              "code"
            ]
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /coupons — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /coupons/{id}": {
      "method": "GET",
      "path": "/coupons/{id}",
      "risk": "R",
      "resource": "coupons",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /coupons/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /coupons/{id}": {
      "method": "PUT",
      "path": "/coupons/{id}",
      "risk": "H",
      "resource": "coupons",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "code": {
                "type": "string",
                "description": "Coupon code.",
                "maxLength": 262144
              },
              "amount": {
                "type": [
                  "number",
                  "string"
                ],
                "description": "The amount of discount. Should always be numeric, even if setting a percentage."
              },
              "status": {
                "type": "string",
                "description": "The status of the coupon. Should always be draft, published, or pending review",
                "maxLength": 262144
              },
              "discount_type": {
                "type": "string",
                "description": "Determines the type of discount that will be applied.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "Coupon description.",
                "maxLength": 262144
              },
              "date_expires": {
                "type": "string",
                "description": "The date the coupon expires, in the site's timezone.",
                "maxLength": 262144
              },
              "date_expires_gmt": {
                "type": "string",
                "description": "The date the coupon expires, as GMT.",
                "maxLength": 262144
              },
              "individual_use": {
                "type": "boolean",
                "description": "If true, the coupon can only be used individually. Other applied coupons will be removed from the cart."
              },
              "product_ids": {
                "type": "array",
                "description": "List of product IDs the coupon can be used on.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "excluded_product_ids": {
                "type": "array",
                "description": "List of product IDs the coupon cannot be used on.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "usage_limit": {
                "type": "integer",
                "description": "How many times the coupon can be used in total.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "usage_limit_per_user": {
                "type": "integer",
                "description": "How many times the coupon can be used per customer.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "limit_usage_to_x_items": {
                "type": "integer",
                "description": "Max number of items in the cart the coupon can be applied to.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "free_shipping": {
                "type": "boolean",
                "description": "If true and if the free shipping method requires a coupon, this coupon will enable free shipping."
              },
              "product_categories": {
                "type": "array",
                "description": "List of category IDs the coupon applies to.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "excluded_product_categories": {
                "type": "array",
                "description": "List of category IDs the coupon does not apply to.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "exclude_sale_items": {
                "type": "boolean",
                "description": "If true, this coupon will not be applied to items that have sale prices."
              },
              "minimum_amount": {
                "type": [
                  "number",
                  "string"
                ],
                "description": "Minimum order amount that needs to be in the cart before coupon applies."
              },
              "maximum_amount": {
                "type": [
                  "number",
                  "string"
                ],
                "description": "Maximum order amount allowed when using the coupon."
              },
              "email_restrictions": {
                "type": "array",
                "description": "List of email addresses that can use this coupon.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "description": "Meta value."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /coupons/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /coupons/{id}": {
      "method": "DELETE",
      "path": "/coupons/{id}",
      "risk": "D",
      "resource": "coupons",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Whether to bypass trash and force deletion."
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
      "ack_key": "id",
      "description": "DELETE /coupons/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /coupons/batch": {
      "method": "POST",
      "path": "/coupons/batch",
      "risk": "D",
      "resource": "coupons",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "code": {
                      "type": "string",
                      "description": "Coupon code.",
                      "maxLength": 262144
                    },
                    "amount": {
                      "type": [
                        "number",
                        "string"
                      ],
                      "description": "The amount of discount. Should always be numeric, even if setting a percentage."
                    },
                    "status": {
                      "type": "string",
                      "description": "The status of the coupon. Should always be draft, published, or pending review",
                      "maxLength": 262144
                    },
                    "discount_type": {
                      "type": "string",
                      "description": "Determines the type of discount that will be applied.",
                      "maxLength": 262144
                    },
                    "description": {
                      "type": "string",
                      "description": "Coupon description.",
                      "maxLength": 262144
                    },
                    "date_expires": {
                      "type": "string",
                      "description": "The date the coupon expires, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_expires_gmt": {
                      "type": "string",
                      "description": "The date the coupon expires, as GMT.",
                      "maxLength": 262144
                    },
                    "individual_use": {
                      "type": "boolean",
                      "description": "If true, the coupon can only be used individually. Other applied coupons will be removed from the cart."
                    },
                    "product_ids": {
                      "type": "array",
                      "description": "List of product IDs the coupon can be used on.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "excluded_product_ids": {
                      "type": "array",
                      "description": "List of product IDs the coupon cannot be used on.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "usage_limit": {
                      "type": "integer",
                      "description": "How many times the coupon can be used in total.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "usage_limit_per_user": {
                      "type": "integer",
                      "description": "How many times the coupon can be used per customer.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "limit_usage_to_x_items": {
                      "type": "integer",
                      "description": "Max number of items in the cart the coupon can be applied to.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "free_shipping": {
                      "type": "boolean",
                      "description": "If true and if the free shipping method requires a coupon, this coupon will enable free shipping."
                    },
                    "product_categories": {
                      "type": "array",
                      "description": "List of category IDs the coupon applies to.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "excluded_product_categories": {
                      "type": "array",
                      "description": "List of category IDs the coupon does not apply to.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "exclude_sale_items": {
                      "type": "boolean",
                      "description": "If true, this coupon will not be applied to items that have sale prices."
                    },
                    "minimum_amount": {
                      "type": [
                        "number",
                        "string"
                      ],
                      "description": "Minimum order amount that needs to be in the cart before coupon applies."
                    },
                    "maximum_amount": {
                      "type": [
                        "number",
                        "string"
                      ],
                      "description": "Maximum order amount allowed when using the coupon."
                    },
                    "email_restrictions": {
                      "type": "array",
                      "description": "List of email addresses that can use this coupon.",
                      "items": {
                        "type": "string",
                        "maxLength": 262144
                      },
                      "maxItems": 10
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "description": "Meta value."
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "code"
                  ]
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "code": {
                      "type": "string",
                      "description": "Coupon code.",
                      "maxLength": 262144
                    },
                    "amount": {
                      "type": [
                        "number",
                        "string"
                      ],
                      "description": "The amount of discount. Should always be numeric, even if setting a percentage."
                    },
                    "status": {
                      "type": "string",
                      "description": "The status of the coupon. Should always be draft, published, or pending review",
                      "maxLength": 262144
                    },
                    "discount_type": {
                      "type": "string",
                      "description": "Determines the type of discount that will be applied.",
                      "maxLength": 262144
                    },
                    "description": {
                      "type": "string",
                      "description": "Coupon description.",
                      "maxLength": 262144
                    },
                    "date_expires": {
                      "type": "string",
                      "description": "The date the coupon expires, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_expires_gmt": {
                      "type": "string",
                      "description": "The date the coupon expires, as GMT.",
                      "maxLength": 262144
                    },
                    "individual_use": {
                      "type": "boolean",
                      "description": "If true, the coupon can only be used individually. Other applied coupons will be removed from the cart."
                    },
                    "product_ids": {
                      "type": "array",
                      "description": "List of product IDs the coupon can be used on.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "excluded_product_ids": {
                      "type": "array",
                      "description": "List of product IDs the coupon cannot be used on.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "usage_limit": {
                      "type": "integer",
                      "description": "How many times the coupon can be used in total.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "usage_limit_per_user": {
                      "type": "integer",
                      "description": "How many times the coupon can be used per customer.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "limit_usage_to_x_items": {
                      "type": "integer",
                      "description": "Max number of items in the cart the coupon can be applied to.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "free_shipping": {
                      "type": "boolean",
                      "description": "If true and if the free shipping method requires a coupon, this coupon will enable free shipping."
                    },
                    "product_categories": {
                      "type": "array",
                      "description": "List of category IDs the coupon applies to.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "excluded_product_categories": {
                      "type": "array",
                      "description": "List of category IDs the coupon does not apply to.",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991
                      },
                      "maxItems": 10
                    },
                    "exclude_sale_items": {
                      "type": "boolean",
                      "description": "If true, this coupon will not be applied to items that have sale prices."
                    },
                    "minimum_amount": {
                      "type": [
                        "number",
                        "string"
                      ],
                      "description": "Minimum order amount that needs to be in the cart before coupon applies."
                    },
                    "maximum_amount": {
                      "type": [
                        "number",
                        "string"
                      ],
                      "description": "Maximum order amount allowed when using the coupon."
                    },
                    "email_restrictions": {
                      "type": "array",
                      "description": "List of email addresses that can use this coupon.",
                      "items": {
                        "type": "string",
                        "maxLength": 262144
                      },
                      "maxItems": 10
                    },
                    "meta_data": {
                      "type": "array",
                      "description": "Meta data.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer",
                            "description": "Meta ID.",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "key": {
                            "type": "string",
                            "description": "Meta key.",
                            "maxLength": 262144
                          },
                          "value": {
                            "description": "Meta value."
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 10
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /coupons/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/reviews": {
      "method": "GET",
      "path": "/products/reviews",
      "risk": "R",
      "resource": "products/reviews",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "maxLength": 262144
              },
              "after": {
                "type": "string",
                "description": "Limit response to resources published after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "before": {
                "type": "string",
                "description": "Limit response to reviews published before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "date",
                  "date_gmt",
                  "id",
                  "include",
                  "product"
                ],
                "description": "Sort collection by object attribute.",
                "maxLength": 262144
              },
              "reviewer": {
                "type": "array",
                "description": "Limit result set to reviews assigned to specific user IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "reviewer_exclude": {
                "type": "array",
                "description": "Ensure result set excludes reviews assigned to specific user IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "reviewer_email": {
                "type": "string",
                "description": "Limit result set to that from a specific author email.",
                "format": "email",
                "maxLength": 262144
              },
              "product": {
                "type": "array",
                "description": "Limit result set to reviews assigned to specific product IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "status": {
                "type": "string",
                "enum": [
                  "all",
                  "hold",
                  "approved",
                  "spam",
                  "trash"
                ],
                "description": "Limit result set to reviews assigned a specific status.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100
              },
              "search": {
                "type": "string",
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
      "ack_key": null,
      "description": "GET /products/reviews — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /products/reviews": {
      "method": "POST",
      "path": "/products/reviews",
      "risk": "H",
      "resource": "products/reviews",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "integer",
                "description": "Unique identifier for the product that the review belongs to.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "product_name": {
                "type": "string",
                "description": "Product name.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "enum": [
                  "approved",
                  "hold",
                  "spam",
                  "unspam",
                  "trash",
                  "untrash"
                ],
                "description": "Status of the review.",
                "maxLength": 262144
              },
              "reviewer": {
                "type": "string",
                "description": "Reviewer name.",
                "maxLength": 262144
              },
              "reviewer_email": {
                "type": "string",
                "description": "Reviewer email.",
                "format": "email",
                "maxLength": 262144
              },
              "review": {
                "type": "string",
                "description": "The content of the review.",
                "maxLength": 262144
              },
              "rating": {
                "type": "integer",
                "description": "Review rating (0 to 5).",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false,
            "required": [
              "product_id",
              "review",
              "reviewer",
              "reviewer_email"
            ]
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /products/reviews — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/reviews/{id}": {
      "method": "GET",
      "path": "/products/reviews/{id}",
      "risk": "R",
      "resource": "products/reviews",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "GET /products/reviews/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /products/reviews/{id}": {
      "method": "PUT",
      "path": "/products/reviews/{id}",
      "risk": "H",
      "resource": "products/reviews",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "integer",
                "description": "Unique identifier for the product that the review belongs to.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "product_name": {
                "type": "string",
                "description": "Product name.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "enum": [
                  "approved",
                  "hold",
                  "spam",
                  "unspam",
                  "trash",
                  "untrash"
                ],
                "description": "Status of the review.",
                "maxLength": 262144
              },
              "reviewer": {
                "type": "string",
                "description": "Reviewer name.",
                "maxLength": 262144
              },
              "reviewer_email": {
                "type": "string",
                "description": "Reviewer email.",
                "format": "email",
                "maxLength": 262144
              },
              "review": {
                "type": "string",
                "description": "The content of the review.",
                "maxLength": 262144
              },
              "rating": {
                "type": "integer",
                "description": "Review rating (0 to 5).",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /products/reviews/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /products/reviews/{id}": {
      "method": "DELETE",
      "path": "/products/reviews/{id}",
      "risk": "D",
      "resource": "products/reviews",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean"
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
      "ack_key": "id",
      "description": "DELETE /products/reviews/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /products/reviews/batch": {
      "method": "POST",
      "path": "/products/reviews/batch",
      "risk": "D",
      "resource": "products/reviews",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "product_id": {
                      "type": "integer",
                      "description": "Unique identifier for the product that the review belongs to.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "product_name": {
                      "type": "string",
                      "description": "Product name.",
                      "maxLength": 262144
                    },
                    "status": {
                      "type": "string",
                      "enum": [
                        "approved",
                        "hold",
                        "spam",
                        "unspam",
                        "trash",
                        "untrash"
                      ],
                      "description": "Status of the review.",
                      "maxLength": 262144
                    },
                    "reviewer": {
                      "type": "string",
                      "description": "Reviewer name.",
                      "maxLength": 262144
                    },
                    "reviewer_email": {
                      "type": "string",
                      "description": "Reviewer email.",
                      "format": "email",
                      "maxLength": 262144
                    },
                    "review": {
                      "type": "string",
                      "description": "The content of the review.",
                      "maxLength": 262144
                    },
                    "rating": {
                      "type": "integer",
                      "description": "Review rating (0 to 5).",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "product_id",
                    "review",
                    "reviewer",
                    "reviewer_email"
                  ]
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "product_id": {
                      "type": "integer",
                      "description": "Unique identifier for the product that the review belongs to.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "product_name": {
                      "type": "string",
                      "description": "Product name.",
                      "maxLength": 262144
                    },
                    "status": {
                      "type": "string",
                      "enum": [
                        "approved",
                        "hold",
                        "spam",
                        "unspam",
                        "trash",
                        "untrash"
                      ],
                      "description": "Status of the review.",
                      "maxLength": 262144
                    },
                    "reviewer": {
                      "type": "string",
                      "description": "Reviewer name.",
                      "maxLength": 262144
                    },
                    "reviewer_email": {
                      "type": "string",
                      "description": "Reviewer email.",
                      "format": "email",
                      "maxLength": 262144
                    },
                    "review": {
                      "type": "string",
                      "description": "The content of the review.",
                      "maxLength": 262144
                    },
                    "rating": {
                      "type": "integer",
                      "description": "Review rating (0 to 5).",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /products/reviews/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /taxes": {
      "method": "GET",
      "path": "/taxes",
      "risk": "R",
      "resource": "taxes",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "description": "Current page of the collection.",
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Maximum number of items to be returned in result set."
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "id",
                  "order",
                  "priority"
                ],
                "description": "Sort collection by object attribute.",
                "maxLength": 262144
              },
              "class": {
                "type": "string",
                "description": "Sort by tax class.",
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
      "ack_key": null,
      "description": "GET /taxes — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /taxes": {
      "method": "POST",
      "path": "/taxes",
      "risk": "H",
      "resource": "taxes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "country": {
                "type": "string",
                "description": "Country ISO 3166 code.",
                "maxLength": 262144
              },
              "state": {
                "type": "string",
                "description": "State code.",
                "maxLength": 262144
              },
              "postcode": {
                "type": "string",
                "description": "Postcode/ZIP, it doesn't support multiple values. Deprecated as of WooCommerce 5.3, 'postcodes' should be used instead.",
                "maxLength": 262144
              },
              "city": {
                "type": "string",
                "description": "City name, it doesn't support multiple values. Deprecated as of WooCommerce 5.3, 'cities' should be used instead.",
                "maxLength": 262144
              },
              "rate": {
                "type": "string",
                "description": "Tax rate.",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "description": "Tax rate name.",
                "maxLength": 262144
              },
              "priority": {
                "type": "integer",
                "description": "Tax priority.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "compound": {
                "type": "boolean",
                "description": "Whether or not this is a compound rate."
              },
              "shipping": {
                "type": "boolean",
                "description": "Whether or not this tax rate also gets applied to shipping."
              },
              "order": {
                "type": "integer",
                "description": "Indicates the order that will appear in queries.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "class": {
                "type": "string",
                "description": "Tax class.",
                "maxLength": 262144
              },
              "postcodes": {
                "type": "array",
                "description": "List of postcodes / ZIPs. Introduced in WooCommerce 5.3.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "cities": {
                "type": "array",
                "description": "List of city names. Introduced in WooCommerce 5.3.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /taxes — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /taxes/{id}": {
      "method": "GET",
      "path": "/taxes/{id}",
      "risk": "R",
      "resource": "taxes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /taxes/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /taxes/{id}": {
      "method": "PUT",
      "path": "/taxes/{id}",
      "risk": "H",
      "resource": "taxes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "country": {
                "type": "string",
                "description": "Country ISO 3166 code.",
                "maxLength": 262144
              },
              "state": {
                "type": "string",
                "description": "State code.",
                "maxLength": 262144
              },
              "postcode": {
                "type": "string",
                "description": "Postcode/ZIP, it doesn't support multiple values. Deprecated as of WooCommerce 5.3, 'postcodes' should be used instead.",
                "maxLength": 262144
              },
              "city": {
                "type": "string",
                "description": "City name, it doesn't support multiple values. Deprecated as of WooCommerce 5.3, 'cities' should be used instead.",
                "maxLength": 262144
              },
              "rate": {
                "type": "string",
                "description": "Tax rate.",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "description": "Tax rate name.",
                "maxLength": 262144
              },
              "priority": {
                "type": "integer",
                "description": "Tax priority.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "compound": {
                "type": "boolean",
                "description": "Whether or not this is a compound rate."
              },
              "shipping": {
                "type": "boolean",
                "description": "Whether or not this tax rate also gets applied to shipping."
              },
              "order": {
                "type": "integer",
                "description": "Indicates the order that will appear in queries.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "class": {
                "type": "string",
                "description": "Tax class.",
                "maxLength": 262144
              },
              "postcodes": {
                "type": "array",
                "description": "List of postcodes / ZIPs. Introduced in WooCommerce 5.3.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "cities": {
                "type": "array",
                "description": "List of city names. Introduced in WooCommerce 5.3.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /taxes/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /taxes/{id}": {
      "method": "DELETE",
      "path": "/taxes/{id}",
      "risk": "D",
      "resource": "taxes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Required to be true, as resource does not support trashing."
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
      "ack_key": "id",
      "description": "DELETE /taxes/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /taxes/batch": {
      "method": "POST",
      "path": "/taxes/batch",
      "risk": "D",
      "resource": "taxes",
      "response_kind": "batch",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "create": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "country": {
                      "type": "string",
                      "description": "Country ISO 3166 code.",
                      "maxLength": 262144
                    },
                    "state": {
                      "type": "string",
                      "description": "State code.",
                      "maxLength": 262144
                    },
                    "postcode": {
                      "type": "string",
                      "description": "Postcode/ZIP, it doesn't support multiple values. Deprecated as of WooCommerce 5.3, 'postcodes' should be used instead.",
                      "maxLength": 262144
                    },
                    "city": {
                      "type": "string",
                      "description": "City name, it doesn't support multiple values. Deprecated as of WooCommerce 5.3, 'cities' should be used instead.",
                      "maxLength": 262144
                    },
                    "rate": {
                      "type": "string",
                      "description": "Tax rate.",
                      "maxLength": 262144
                    },
                    "name": {
                      "type": "string",
                      "description": "Tax rate name.",
                      "maxLength": 262144
                    },
                    "priority": {
                      "type": "integer",
                      "description": "Tax priority.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "compound": {
                      "type": "boolean",
                      "description": "Whether or not this is a compound rate."
                    },
                    "shipping": {
                      "type": "boolean",
                      "description": "Whether or not this tax rate also gets applied to shipping."
                    },
                    "order": {
                      "type": "integer",
                      "description": "Indicates the order that will appear in queries.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "class": {
                      "type": "string",
                      "description": "Tax class.",
                      "maxLength": 262144
                    },
                    "postcodes": {
                      "type": "array",
                      "description": "List of postcodes / ZIPs. Introduced in WooCommerce 5.3.",
                      "items": {
                        "type": "string",
                        "maxLength": 262144
                      },
                      "maxItems": 10
                    },
                    "cities": {
                      "type": "array",
                      "description": "List of city names. Introduced in WooCommerce 5.3.",
                      "items": {
                        "type": "string",
                        "maxLength": 262144
                      },
                      "maxItems": 10
                    }
                  },
                  "additionalProperties": false,
                  "required": []
                },
                "maxItems": 10
              },
              "update": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "country": {
                      "type": "string",
                      "description": "Country ISO 3166 code.",
                      "maxLength": 262144
                    },
                    "state": {
                      "type": "string",
                      "description": "State code.",
                      "maxLength": 262144
                    },
                    "postcode": {
                      "type": "string",
                      "description": "Postcode/ZIP, it doesn't support multiple values. Deprecated as of WooCommerce 5.3, 'postcodes' should be used instead.",
                      "maxLength": 262144
                    },
                    "city": {
                      "type": "string",
                      "description": "City name, it doesn't support multiple values. Deprecated as of WooCommerce 5.3, 'cities' should be used instead.",
                      "maxLength": 262144
                    },
                    "rate": {
                      "type": "string",
                      "description": "Tax rate.",
                      "maxLength": 262144
                    },
                    "name": {
                      "type": "string",
                      "description": "Tax rate name.",
                      "maxLength": 262144
                    },
                    "priority": {
                      "type": "integer",
                      "description": "Tax priority.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "compound": {
                      "type": "boolean",
                      "description": "Whether or not this is a compound rate."
                    },
                    "shipping": {
                      "type": "boolean",
                      "description": "Whether or not this tax rate also gets applied to shipping."
                    },
                    "order": {
                      "type": "integer",
                      "description": "Indicates the order that will appear in queries.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "class": {
                      "type": "string",
                      "description": "Tax class.",
                      "maxLength": 262144
                    },
                    "postcodes": {
                      "type": "array",
                      "description": "List of postcodes / ZIPs. Introduced in WooCommerce 5.3.",
                      "items": {
                        "type": "string",
                        "maxLength": 262144
                      },
                      "maxItems": 10
                    },
                    "cities": {
                      "type": "array",
                      "description": "List of city names. Introduced in WooCommerce 5.3.",
                      "items": {
                        "type": "string",
                        "maxLength": 262144
                      },
                      "maxItems": 10
                    },
                    "id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ]
                },
                "maxItems": 10
              },
              "delete": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "maxItems": 10,
                "uniqueItems": true
              }
            },
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /taxes/batch — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /taxes/classes": {
      "method": "GET",
      "path": "/taxes/classes",
      "risk": "R",
      "resource": "taxes/classes",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "slug",
      "description": "GET /taxes/classes — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /taxes/classes": {
      "method": "POST",
      "path": "/taxes/classes",
      "risk": "H",
      "resource": "taxes/classes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Tax class name.",
                "maxLength": 262144
              }
            },
            "additionalProperties": false,
            "required": [
              "name"
            ]
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "slug",
      "description": "POST /taxes/classes — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /taxes/classes/{slug}": {
      "method": "DELETE",
      "path": "/taxes/classes/{slug}",
      "risk": "D",
      "resource": "taxes/classes",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "slug": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              }
            },
            "required": [
              "slug"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Required to be true, as resource does not support trashing."
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
      "ack_key": "slug",
      "description": "DELETE /taxes/classes/{slug} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /shipping/zones": {
      "method": "GET",
      "path": "/shipping/zones",
      "risk": "R",
      "resource": "shipping/zones",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /shipping/zones — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /shipping/zones": {
      "method": "POST",
      "path": "/shipping/zones",
      "risk": "H",
      "resource": "shipping/zones",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Shipping zone name.",
                "maxLength": 262144
              },
              "order": {
                "type": "integer",
                "description": "Shipping zone order.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false,
            "required": [
              "name"
            ]
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /shipping/zones — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /shipping/zones/{id}": {
      "method": "GET",
      "path": "/shipping/zones/{id}",
      "risk": "R",
      "resource": "shipping/zones",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "GET /shipping/zones/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /shipping/zones/{id}": {
      "method": "PUT",
      "path": "/shipping/zones/{id}",
      "risk": "H",
      "resource": "shipping/zones",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Shipping zone name.",
                "maxLength": 262144
              },
              "order": {
                "type": "integer",
                "description": "Shipping zone order.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "PUT /shipping/zones/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /shipping/zones/{id}": {
      "method": "DELETE",
      "path": "/shipping/zones/{id}",
      "risk": "D",
      "resource": "shipping/zones",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Whether to bypass trash and force deletion."
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
      "ack_key": "id",
      "description": "DELETE /shipping/zones/{id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /shipping/zones/{id}/locations": {
      "method": "GET",
      "path": "/shipping/zones/{id}/locations",
      "risk": "R",
      "resource": "shipping/zones/{id}/locations",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /shipping/zones/{id}/locations — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /shipping/zones/{id}/locations": {
      "method": "PUT",
      "path": "/shipping/zones/{id}/locations",
      "risk": "H",
      "resource": "shipping/zones/{id}/locations",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "code": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 256
                },
                "type": {
                  "type": "string",
                  "enum": [
                    "postcode",
                    "state",
                    "country",
                    "continent"
                  ],
                  "description": "Shipping zone location type.",
                  "maxLength": 262144
                }
              },
              "additionalProperties": false,
              "required": [
                "code"
              ]
            },
            "maxItems": 10
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "PUT /shipping/zones/{id}/locations — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /shipping/zones/{zone_id}/methods": {
      "method": "GET",
      "path": "/shipping/zones/{zone_id}/methods",
      "risk": "R",
      "resource": "shipping/zones/{zone_id}/methods",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "zone_id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "zone_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "ack_key": "instance_id",
      "description": "GET /shipping/zones/{zone_id}/methods — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /shipping/zones/{zone_id}/methods": {
      "method": "POST",
      "path": "/shipping/zones/{zone_id}/methods",
      "risk": "H",
      "resource": "shipping/zones/{zone_id}/methods",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "zone_id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "zone_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "order": {
                "type": "integer",
                "description": "Shipping method sort order.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "enabled": {
                "type": "boolean",
                "description": "Shipping method enabled status."
              },
              "settings": {
                "type": "object",
                "additionalProperties": {
                  "anyOf": [
                    {
                      "type": [
                        "string",
                        "number",
                        "boolean",
                        "null"
                      ]
                    },
                    {
                      "type": "array",
                      "items": {
                        "type": [
                          "string",
                          "number"
                        ]
                      },
                      "maxItems": 10
                    },
                    {
                      "type": "object",
                      "properties": {
                        "width": {
                          "type": "integer"
                        },
                        "height": {
                          "type": "integer"
                        },
                        "crop": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false
                    }
                  ]
                }
              },
              "method_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              }
            },
            "additionalProperties": false,
            "required": [
              "method_id"
            ]
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "instance_id",
      "description": "POST /shipping/zones/{zone_id}/methods — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /shipping/zones/{zone_id}/methods/{instance_id}": {
      "method": "GET",
      "path": "/shipping/zones/{zone_id}/methods/{instance_id}",
      "risk": "R",
      "resource": "shipping/zones/{zone_id}/methods",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "zone_id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "instance_id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "zone_id",
              "instance_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "ack_key": "instance_id",
      "description": "GET /shipping/zones/{zone_id}/methods/{instance_id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "PUT /shipping/zones/{zone_id}/methods/{instance_id}": {
      "method": "PUT",
      "path": "/shipping/zones/{zone_id}/methods/{instance_id}",
      "risk": "H",
      "resource": "shipping/zones/{zone_id}/methods",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "zone_id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "instance_id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "zone_id",
              "instance_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "order": {
                "type": "integer",
                "description": "Shipping method sort order.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "enabled": {
                "type": "boolean",
                "description": "Shipping method enabled status."
              },
              "settings": {
                "type": "object",
                "additionalProperties": {
                  "anyOf": [
                    {
                      "type": [
                        "string",
                        "number",
                        "boolean",
                        "null"
                      ]
                    },
                    {
                      "type": "array",
                      "items": {
                        "type": [
                          "string",
                          "number"
                        ]
                      },
                      "maxItems": 10
                    },
                    {
                      "type": "object",
                      "properties": {
                        "width": {
                          "type": "integer"
                        },
                        "height": {
                          "type": "integer"
                        },
                        "crop": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false
                    }
                  ]
                }
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "instance_id",
      "description": "PUT /shipping/zones/{zone_id}/methods/{instance_id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "DELETE /shipping/zones/{zone_id}/methods/{instance_id}": {
      "method": "DELETE",
      "path": "/shipping/zones/{zone_id}/methods/{instance_id}",
      "risk": "D",
      "resource": "shipping/zones/{zone_id}/methods",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "zone_id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "instance_id": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "zone_id",
              "instance_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Whether to bypass trash and force deletion."
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
      "ack_key": "instance_id",
      "description": "DELETE /shipping/zones/{zone_id}/methods/{instance_id} — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /shipping_methods": {
      "method": "GET",
      "path": "/shipping_methods",
      "risk": "R",
      "resource": "shipping_methods",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": null,
      "description": "GET /shipping_methods — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /shipping_methods/{id}": {
      "method": "GET",
      "path": "/shipping_methods/{id}",
      "risk": "R",
      "resource": "shipping_methods",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": "id",
      "description": "GET /shipping_methods/{id} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /data": {
      "method": "GET",
      "path": "/data",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /data — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /data/countries": {
      "method": "GET",
      "path": "/data/countries",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /data/countries — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /data/countries/{location}": {
      "method": "GET",
      "path": "/data/countries/{location}",
      "risk": "R",
      "resource": null,
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "location": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              }
            },
            "required": [
              "location"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /data/countries/{location} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /data/continents": {
      "method": "GET",
      "path": "/data/continents",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /data/continents — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /data/continents/{location}": {
      "method": "GET",
      "path": "/data/continents/{location}",
      "risk": "R",
      "resource": null,
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "location": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              }
            },
            "required": [
              "location"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /data/continents/{location} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /data/currencies": {
      "method": "GET",
      "path": "/data/currencies",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /data/currencies — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /data/currencies/current": {
      "method": "GET",
      "path": "/data/currencies/current",
      "risk": "R",
      "resource": null,
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /data/currencies/current — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /data/currencies/{currency}": {
      "method": "GET",
      "path": "/data/currencies/{currency}",
      "risk": "R",
      "resource": null,
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "currency": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              }
            },
            "required": [
              "currency"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /data/currencies/{currency} — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /reports": {
      "method": "GET",
      "path": "/reports",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": null,
      "description": "GET /reports — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /reports/sales": {
      "method": "GET",
      "path": "/reports/sales",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "period": {
                "type": "string",
                "enum": [
                  "week",
                  "month",
                  "last_month",
                  "year"
                ],
                "description": "Report period.",
                "maxLength": 262144
              },
              "date_min": {
                "type": "string",
                "description": "Return sales for a specific start date, the date need to be in the YYYY-MM-DD format.",
                "maxLength": 262144
              },
              "date_max": {
                "type": "string",
                "description": "Return sales for a specific end date, the date need to be in the YYYY-MM-DD format.",
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
      "ack_key": null,
      "description": "GET /reports/sales — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /reports/top_sellers": {
      "method": "GET",
      "path": "/reports/top_sellers",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "period": {
                "type": "string",
                "enum": [
                  "week",
                  "month",
                  "last_month",
                  "year"
                ],
                "description": "Report period.",
                "maxLength": 262144
              },
              "date_min": {
                "type": "string",
                "description": "Return sales for a specific start date, the date need to be in the YYYY-MM-DD format.",
                "maxLength": 262144
              },
              "date_max": {
                "type": "string",
                "description": "Return sales for a specific end date, the date need to be in the YYYY-MM-DD format.",
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
      "ack_key": null,
      "description": "GET /reports/top_sellers — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /reports/orders/totals": {
      "method": "GET",
      "path": "/reports/orders/totals",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /reports/orders/totals — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /reports/products/totals": {
      "method": "GET",
      "path": "/reports/products/totals",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /reports/products/totals — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /reports/customers/totals": {
      "method": "GET",
      "path": "/reports/customers/totals",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /reports/customers/totals — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /reports/coupons/totals": {
      "method": "GET",
      "path": "/reports/coupons/totals",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /reports/coupons/totals — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /reports/reviews/totals": {
      "method": "GET",
      "path": "/reports/reviews/totals",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /reports/reviews/totals — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /customers/{customer_id}/downloads": {
      "method": "GET",
      "path": "/customers/{customer_id}/downloads",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "customer_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "customer_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": null,
      "description": "GET /customers/{customer_id}/downloads — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /system_status": {
      "method": "GET",
      "path": "/system_status",
      "risk": "R",
      "resource": null,
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
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
      "ack_key": null,
      "description": "GET /system_status — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /products/custom-fields/names": {
      "method": "GET",
      "path": "/products/custom-fields/names",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100
              },
              "search": {
                "type": "string",
                "maxLength": 262144
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
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
      "ack_key": null,
      "description": "GET /products/custom-fields/names — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /refunds": {
      "method": "GET",
      "path": "/refunds",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "description": "Current page of the collection.",
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Maximum number of items to be returned in result set."
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "after": {
                "type": "string",
                "description": "Limit response to resources published after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "before": {
                "type": "string",
                "description": "Limit response to resources published before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "date",
                  "id",
                  "include",
                  "title",
                  "slug",
                  "modified"
                ],
                "description": "Sort collection by object attribute.",
                "maxLength": 262144
              },
              "parent": {
                "type": "array",
                "description": "Limit result set to those of particular parent IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "parent_exclude": {
                "type": "array",
                "description": "Limit result set to all items except those of a particular parent ID.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "dp": {
                "type": "integer",
                "description": "Number of decimal points to use in each resource.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "modified_after": {
                "type": "string",
                "description": "Limit response to resources modified after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "modified_before": {
                "type": "string",
                "description": "Limit response to resources modified before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "dates_are_gmt": {
                "type": "boolean",
                "description": "Whether to consider GMT post dates when limiting response by published or modified date."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /refunds — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /orders/{id}/actions/email_templates": {
      "method": "GET",
      "path": "/orders/{id}/actions/email_templates",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /orders/{id}/actions/email_templates — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /orders/{id}/actions/send_email": {
      "method": "POST",
      "path": "/orders/{id}/actions/send_email",
      "risk": "H",
      "resource": null,
      "response_kind": "message",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "email": {
                "type": "string",
                "format": "email",
                "maxLength": 262144
              },
              "force_email_update": {
                "type": "boolean"
              },
              "template_id": {
                "type": "string",
                "description": "Use an ID returned by email_templates; available templates depend on the order.",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "message",
      "description": "POST /orders/{id}/actions/send_email — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "POST /orders/{id}/actions/send_order_details": {
      "method": "POST",
      "path": "/orders/{id}/actions/send_order_details",
      "risk": "H",
      "resource": null,
      "response_kind": "message",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "email": {
                "type": "string",
                "format": "email",
                "maxLength": 262144
              },
              "force_email_update": {
                "type": "boolean"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "message",
      "description": "POST /orders/{id}/actions/send_order_details — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /products/shipping_classes/slug-suggestion": {
      "method": "GET",
      "path": "/products/shipping_classes/slug-suggestion",
      "risk": "R",
      "resource": null,
      "response_kind": "string",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
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
      "ack_key": null,
      "description": "GET /products/shipping_classes/slug-suggestion — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /products/{id}/duplicate": {
      "method": "POST",
      "path": "/products/{id}/duplicate",
      "risk": "H",
      "resource": "products",
      "response_kind": "object",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Product name.",
                "maxLength": 262144
              },
              "slug": {
                "type": "string",
                "description": "Product slug.",
                "maxLength": 262144
              },
              "date_created": {
                "type": "string",
                "description": "The date the product was created, in the site's timezone.",
                "maxLength": 262144
              },
              "date_created_gmt": {
                "type": "string",
                "description": "The date the product was created, as GMT.",
                "maxLength": 262144
              },
              "type": {
                "type": "string",
                "description": "Product type.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "description": "Product status (post status).",
                "maxLength": 262144
              },
              "featured": {
                "type": "boolean",
                "description": "Featured product."
              },
              "catalog_visibility": {
                "type": "string",
                "description": "Catalog visibility.",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "description": "Product description.",
                "maxLength": 262144
              },
              "short_description": {
                "type": "string",
                "description": "Product short description.",
                "maxLength": 262144
              },
              "sku": {
                "type": "string",
                "description": "Stock Keeping Unit.",
                "maxLength": 262144
              },
              "global_unique_id": {
                "type": "string",
                "description": "GTIN, UPC, EAN or ISBN.",
                "maxLength": 262144
              },
              "regular_price": {
                "type": "string",
                "description": "Product regular price.",
                "maxLength": 262144
              },
              "sale_price": {
                "type": "string",
                "description": "Product sale price.",
                "maxLength": 262144
              },
              "date_on_sale_from": {
                "type": "string",
                "description": "Start date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "date_on_sale_from_gmt": {
                "type": "string",
                "description": "Start date of sale price, as GMT.",
                "maxLength": 262144
              },
              "date_on_sale_to": {
                "type": "string",
                "description": "End date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "date_on_sale_to_gmt": {
                "type": "string",
                "description": "End date of sale price, in the site's timezone.",
                "maxLength": 262144
              },
              "virtual": {
                "type": "boolean",
                "description": "If the product is virtual."
              },
              "downloadable": {
                "type": "boolean",
                "description": "If the product is downloadable."
              },
              "downloads": {
                "type": "array",
                "description": "List of downloadable files.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "description": "File ID.",
                      "maxLength": 262144
                    },
                    "name": {
                      "type": "string",
                      "description": "File name.",
                      "maxLength": 262144
                    },
                    "file": {
                      "type": "string",
                      "description": "File URL.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "download_limit": {
                "type": "integer",
                "description": "Number of times downloadable files can be downloaded after purchase.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "download_expiry": {
                "type": "integer",
                "description": "Number of days until access to downloadable files expires.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "external_url": {
                "type": "string",
                "description": "Product external URL. Only for external products.",
                "format": "uri",
                "maxLength": 262144
              },
              "button_text": {
                "type": "string",
                "description": "Product external button text. Only for external products.",
                "maxLength": 262144
              },
              "tax_status": {
                "type": "string",
                "description": "Tax status.",
                "maxLength": 262144
              },
              "tax_class": {
                "type": "string",
                "description": "Tax class.",
                "maxLength": 262144
              },
              "manage_stock": {
                "type": "boolean",
                "description": "Stock management at product level."
              },
              "stock_quantity": {
                "type": "number",
                "description": "Stock quantity."
              },
              "stock_status": {
                "type": "string",
                "description": "Controls the stock status of the product.",
                "maxLength": 262144
              },
              "backorders": {
                "type": "string",
                "enum": [
                  "no",
                  "notify",
                  "yes"
                ],
                "description": "If managing stock, this controls if backorders are allowed.",
                "maxLength": 262144
              },
              "low_stock_amount": {
                "type": [
                  "integer",
                  "null"
                ],
                "description": "Low Stock amount for the product."
              },
              "sold_individually": {
                "type": "boolean",
                "description": "Allow one item to be bought in a single order."
              },
              "weight": {
                "type": "string",
                "maxLength": 262144
              },
              "dimensions": {
                "type": "object",
                "description": "Product dimensions.",
                "properties": {
                  "length": {
                    "type": "string",
                    "maxLength": 262144
                  },
                  "width": {
                    "type": "string",
                    "maxLength": 262144
                  },
                  "height": {
                    "type": "string",
                    "maxLength": 262144
                  }
                },
                "additionalProperties": false
              },
              "shipping_class": {
                "type": "string",
                "description": "Shipping class slug.",
                "maxLength": 262144
              },
              "reviews_allowed": {
                "type": "boolean",
                "description": "Allow reviews."
              },
              "post_password": {
                "type": "string",
                "description": "Post password.",
                "maxLength": 262144
              },
              "upsell_ids": {
                "type": "array",
                "description": "List of up-sell products IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "cross_sell_ids": {
                "type": "array",
                "description": "List of cross-sell products IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 10
              },
              "parent_id": {
                "type": "integer",
                "description": "Product parent ID.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "purchase_note": {
                "type": "string",
                "description": "Optional note to send the customer after purchase.",
                "maxLength": 262144
              },
              "categories": {
                "type": "array",
                "description": "List of categories.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Category ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Category name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "Category slug.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "brands": {
                "type": "array",
                "description": "List of brands.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Brand ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Brand name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "Brand slug.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "tags": {
                "type": "array",
                "description": "List of tags.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Tag ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Tag name.",
                      "maxLength": 262144
                    },
                    "slug": {
                      "type": "string",
                      "description": "Tag slug.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "images": {
                "type": "array",
                "description": "List of images.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Image ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "date_created": {
                      "type": "string",
                      "description": "The date the image was created, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_created_gmt": {
                      "type": "string",
                      "description": "The date the image was created, as GMT.",
                      "maxLength": 262144
                    },
                    "date_modified": {
                      "type": "string",
                      "description": "The date the image was last modified, in the site's timezone.",
                      "maxLength": 262144
                    },
                    "date_modified_gmt": {
                      "type": "string",
                      "description": "The date the image was last modified, as GMT.",
                      "maxLength": 262144
                    },
                    "src": {
                      "type": "string",
                      "description": "Image URL.",
                      "format": "uri",
                      "maxLength": 262144
                    },
                    "name": {
                      "type": "string",
                      "description": "Image name.",
                      "maxLength": 262144
                    },
                    "alt": {
                      "type": "string",
                      "description": "Image alternative text.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "attributes": {
                "type": "array",
                "description": "List of attributes.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Attribute ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Attribute name.",
                      "maxLength": 262144
                    },
                    "position": {
                      "type": "integer",
                      "description": "Attribute position.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "visible": {
                      "type": "boolean",
                      "description": "Define if the attribute is visible on the \"Additional information\" tab in the product's page."
                    },
                    "variation": {
                      "type": "boolean",
                      "description": "Define if the attribute can be used as variation."
                    },
                    "options": {
                      "type": "array",
                      "description": "List of available term names of the attribute.",
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
              "default_attributes": {
                "type": "array",
                "description": "Defaults variation attributes.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Attribute ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "name": {
                      "type": "string",
                      "description": "Attribute name.",
                      "maxLength": 262144
                    },
                    "option": {
                      "type": "string",
                      "description": "Selected attribute term name.",
                      "maxLength": 262144
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              },
              "menu_order": {
                "type": "integer",
                "description": "Menu order, used to custom sort products.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "meta_data": {
                "type": "array",
                "description": "Meta data.",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer",
                      "description": "Meta ID.",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "key": {
                      "type": "string",
                      "description": "Meta key.",
                      "maxLength": 262144
                    },
                    "value": {
                      "description": "Meta value."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false,
            "required": []
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": "id",
      "description": "POST /products/{id}/duplicate — WooCommerce 11.1.2 merchant API. Acknowledgement only; inspect state before retrying an uncertain write."
    },
    "GET /variations": {
      "method": "GET",
      "path": "/variations",
      "risk": "R",
      "resource": "products/{product_id}/variations",
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "integer",
                "description": "Unique identifier for the variable product.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "description": "Current page of the collection.",
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Maximum number of items to be returned in result set."
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "after": {
                "type": "string",
                "description": "Limit response to resources published after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "before": {
                "type": "string",
                "description": "Limit response to resources published before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "enum": [
                  "date",
                  "id",
                  "include",
                  "title",
                  "slug",
                  "modified"
                ],
                "description": "Sort collection by object attribute.",
                "maxLength": 262144
              },
              "parent": {
                "type": "array",
                "description": "Limit result set to those of particular parent IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "parent_exclude": {
                "type": "array",
                "description": "Limit result set to all items except those of a particular parent ID.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "slug": {
                "type": "string",
                "description": "Limit result set to products with a specific slug.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "enum": [
                  "any",
                  "draft",
                  "pending",
                  "private",
                  "publish"
                ],
                "description": "Limit result set to products assigned a specific status.",
                "maxLength": 262144
              },
              "type": {
                "type": "string",
                "enum": [
                  "simple",
                  "grouped",
                  "external",
                  "variable"
                ],
                "description": "Limit result set to products assigned a specific type.",
                "maxLength": 262144
              },
              "sku": {
                "type": "string",
                "description": "Limit result set to products with a specific SKU.",
                "maxLength": 262144
              },
              "featured": {
                "type": "boolean",
                "description": "Limit result set to featured products."
              },
              "category": {
                "type": "string",
                "description": "Limit result set to products assigned a specific category ID.",
                "maxLength": 262144
              },
              "tag": {
                "type": "string",
                "description": "Limit result set to products assigned a specific tag ID.",
                "maxLength": 262144
              },
              "shipping_class": {
                "type": "string",
                "description": "Limit result set to products assigned a specific shipping class ID.",
                "maxLength": 262144
              },
              "attribute": {
                "type": "string",
                "description": "Limit result set to products with a specific attribute.",
                "maxLength": 262144
              },
              "attribute_term": {
                "type": "string",
                "description": "Limit result set to products with a specific attribute term ID (required an assigned attribute).",
                "maxLength": 262144
              },
              "tax_class": {
                "type": "string",
                "enum": [
                  "standard",
                  "reduced-rate",
                  "zero-rate"
                ],
                "description": "Limit result set to products with a specific tax class.",
                "maxLength": 262144
              },
              "in_stock": {
                "type": "boolean",
                "description": "Limit result set to products in stock or out of stock."
              },
              "on_sale": {
                "type": "boolean",
                "description": "Limit result set to products on sale."
              },
              "min_price": {
                "type": "string",
                "description": "Limit result set to products based on a minimum price.",
                "maxLength": 262144
              },
              "max_price": {
                "type": "string",
                "description": "Limit result set to products based on a maximum price.",
                "maxLength": 262144
              },
              "image_size": {
                "type": "string",
                "description": "Use a specific registered image size for the returned variation image src. Falls back to the full size if the requested size is not registered.",
                "maxLength": 262144
              },
              "modified_after": {
                "type": "string",
                "description": "Limit response to resources modified after a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "modified_before": {
                "type": "string",
                "description": "Limit response to resources modified before a given ISO8601 compliant date.",
                "format": "date-time",
                "maxLength": 262144
              },
              "dates_are_gmt": {
                "type": "boolean",
                "description": "Whether to consider GMT post dates when limiting response by published or modified date."
              },
              "stock_status": {
                "type": "string",
                "description": "Limit result set to products with specified stock status.",
                "maxLength": 262144
              },
              "has_price": {
                "type": "boolean",
                "description": "Limit result set to products with or without price."
              },
              "attributes": {
                "type": "array",
                "description": "Limit result set to products with specified attributes.",
                "items": {
                  "type": "object",
                  "properties": {
                    "attribute": {
                      "type": "string",
                      "description": "Attribute slug.",
                      "maxLength": 262144
                    },
                    "term": {
                      "type": "string",
                      "description": "Attribute term.",
                      "maxLength": 262144
                    },
                    "terms": {
                      "type": "array",
                      "description": "Attribute terms.",
                      "items": {},
                      "maxItems": 100
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 100
              },
              "virtual": {
                "type": "boolean",
                "description": "Limit result set to virtual product variations."
              },
              "downloadable": {
                "type": "boolean",
                "description": "Limit result set to downloadable product variations."
              },
              "include_status": {
                "type": "array",
                "description": "Limit result set to product variations with any of the statuses.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "exclude_status": {
                "type": "array",
                "description": "Exclude product variations with any of the statuses from result set.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "pos_products_only": {
                "type": "boolean",
                "description": "Limit result set to variations visible in Point of Sale."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /variations — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /products/suggested-products": {
      "method": "GET",
      "path": "/products/suggested-products",
      "risk": "R",
      "resource": null,
      "response_kind": "array",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "context": {
                "type": "string",
                "enum": [
                  "view",
                  "edit"
                ],
                "description": "Scope under which the request is made; determines fields present in response.",
                "maxLength": 262144
              },
              "page": {
                "type": "integer",
                "description": "Current page of the collection.",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "per_page": {
                "type": "integer",
                "description": "Maximum number of items to be returned in result set.",
                "minimum": 1,
                "maximum": 100
              },
              "search": {
                "type": "string",
                "description": "Limit results to those matching a string.",
                "maxLength": 262144
              },
              "after": {
                "type": "string",
                "description": "Limit response to resources published after a given ISO8601 compliant date.",
                "maxLength": 262144
              },
              "before": {
                "type": "string",
                "description": "Limit response to resources published before a given ISO8601 compliant date.",
                "maxLength": 262144
              },
              "exclude": {
                "type": "array",
                "description": "Ensure result set excludes specific IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "include": {
                "type": "array",
                "description": "Limit result set to specific ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "offset": {
                "type": "integer",
                "description": "Offset the result set by a specific number of items.",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "order": {
                "type": "string",
                "enum": [
                  "asc",
                  "desc"
                ],
                "description": "Order sort attribute ascending or descending.",
                "maxLength": 262144
              },
              "orderby": {
                "type": "string",
                "description": "Sort collection by object attribute.",
                "maxLength": 262144
              },
              "parent": {
                "type": "array",
                "description": "Limit result set to those of particular parent IDs.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "parent_exclude": {
                "type": "array",
                "description": "Limit result set to all items except those of a particular parent ID.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "slug": {
                "type": "string",
                "description": "Limit result set to products with a specific slug.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "description": "Limit result set to products assigned a specific status.",
                "maxLength": 262144
              },
              "type": {
                "type": "string",
                "description": "Limit result set to products assigned a specific type.",
                "maxLength": 262144
              },
              "sku": {
                "type": "string",
                "description": "Limit result set to products with specific SKU(s). Use commas to separate.",
                "maxLength": 262144
              },
              "featured": {
                "type": "boolean",
                "description": "Limit result set to featured products."
              },
              "category": {
                "type": "string",
                "description": "Limit result set to products assigned a specific category ID.",
                "maxLength": 262144
              },
              "tag": {
                "type": "string",
                "description": "Limit result set to products assigned a specific tag ID.",
                "maxLength": 262144
              },
              "shipping_class": {
                "type": "string",
                "description": "Limit result set to products assigned a specific shipping class ID.",
                "maxLength": 262144
              },
              "attribute": {
                "type": "string",
                "description": "Limit result set to products with a specific attribute. Use the taxonomy name/attribute slug.",
                "maxLength": 262144
              },
              "attribute_term": {
                "type": "string",
                "description": "Limit result set to products with a specific attribute term ID (required an assigned attribute).",
                "maxLength": 262144
              },
              "tax_class": {
                "type": "string",
                "description": "Limit result set to products with a specific tax class.",
                "maxLength": 262144
              },
              "in_stock": {
                "type": "boolean",
                "description": "Limit result set to products in stock or out of stock."
              },
              "on_sale": {
                "type": "boolean",
                "description": "Limit result set to products on sale."
              },
              "min_price": {
                "type": "string",
                "description": "Limit result set to products based on a minimum price.",
                "maxLength": 262144
              },
              "max_price": {
                "type": "string",
                "description": "Limit result set to products based on a maximum price.",
                "maxLength": 262144
              },
              "image_size": {
                "type": "string",
                "description": "Image size to return. Accepts any registered WordPress image size.",
                "maxLength": 262144
              },
              "include_meta": {
                "type": "array",
                "description": "Limit meta_data to specific keys.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "exclude_meta": {
                "type": "array",
                "description": "Ensure meta_data excludes specific keys.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "categories": {
                "type": "array",
                "description": "Limit result set to specific product categorie ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "tags": {
                "type": "array",
                "description": "Limit result set to specific product tag ids.",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "maxItems": 100
              },
              "limit": {
                "type": "integer",
                "description": "Limit result set to specific amount of suggested products.",
                "minimum": 1,
                "maximum": 100
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /products/suggested-products — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "GET /products/{id}/related": {
      "method": "GET",
      "path": "/products/{id}/related",
      "risk": "R",
      "resource": null,
      "response_kind": "related",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "GET /products/{id}/related — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    },
    "POST /orders/{order_id}/refunds/preview": {
      "method": "POST",
      "path": "/orders/{order_id}/refunds/preview",
      "risk": "R",
      "resource": null,
      "response_kind": "preview",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "line_items": {
                "type": "array",
                "minItems": 1,
                "description": "Line items to include in the refund preview.",
                "items": {
                  "type": "object",
                  "properties": {
                    "line_item_id": {
                      "type": "integer",
                      "minimum": 1,
                      "description": "ID of the original order line item.",
                      "maximum": 9007199254740991
                    },
                    "quantity": {
                      "type": "integer",
                      "minimum": 1,
                      "description": "Quantity to refund. Required when refund_total is omitted.",
                      "maximum": 9007199254740991
                    },
                    "refund_total": {
                      "type": [
                        "number",
                        "null"
                      ],
                      "description": "Tax-inclusive amount to refund for this line item. Must be non-zero and match the line's sign (negative for discount or credit lines, positive otherwise). Required when quantity is omitted."
                    }
                  },
                  "additionalProperties": false,
                  "required": [
                    "line_item_id"
                  ]
                },
                "maxItems": 100
              }
            },
            "required": [
              "line_items"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "ack_key": null,
      "description": "POST /orders/{order_id}/refunds/preview — WooCommerce 11.1.2 merchant API. Returns one page with pagination metadata."
    }
  },
  "excluded_groups": {
    "system_status/tools": "Store-maintenance commands are not merchant business CRUD.",
    "settings/payment_gateways": "Store/application configuration includes credentials and plugin-defined settings; no new configuration flow.",
    "webhooks": "Requires merchant delivery endpoint and credentials; no receiver setup is added.",
    "paypal-*": "Requires separate PayPal identity and checkout/session workflows.",
    "plugins/network/admin": "Not part of the existing single-store merchant business grant.",
    "conditional_cogs_fields": "Feature-gated Cost of Goods Sold schema is not enabled or established by the existing connector binding.",
    "products/{product_id}/variations/generate": "Official controller defaults to up to 99 generated variants, plus optional deletion of all unmatched variants. No request-side count bound exists, so this atomic bulk operation cannot meet the existing host D batch cap of 10. Use bounded explicit variation batch CRUD instead."
  }
};
