'use strict';
// Generated from pinned official Shoplazza v202601 merchant contracts.
module.exports = {
  "version": "2026-01",
  "methods": {
    "address-create": {
      "risk": "W",
      "module": "customers",
      "method": "POST",
      "path": "/customers/{customer_id}/addresses",
      "description": "Create address",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "customer_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Customer ID"
              }
            },
            "required": [
              "customer_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "address": {
                "$ref": "#/$defs/v202506.CreateAddressParam",
                "description": "Address"
              }
            },
            "required": [
              "address"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a new address with the provided details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateAddressParam": {
            "type": "object",
            "properties": {
              "country": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "country_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "first_name": {
                "type": "string",
                "maxLength": 262144
              },
              "last_name": {
                "type": "string",
                "maxLength": 262144
              },
              "address1": {
                "type": "string",
                "maxLength": 262144
              },
              "address2": {
                "type": "string",
                "maxLength": 262144
              },
              "area": {
                "type": "string",
                "maxLength": 262144
              },
              "city": {
                "type": "string",
                "maxLength": 262144
              },
              "province": {
                "type": "string",
                "maxLength": 262144
              },
              "province_code": {
                "type": "string",
                "maxLength": 262144
              },
              "company": {
                "type": "string",
                "maxLength": 262144
              },
              "phone": {
                "type": "string",
                "maxLength": 262144
              },
              "phone_area_code": {
                "type": "string",
                "maxLength": 262144
              },
              "zip": {
                "type": "string",
                "maxLength": 262144
              },
              "gender": {
                "type": "string",
                "maxLength": 262144
              },
              "email": {
                "type": "string",
                "maxLength": 262144
              },
              "default": {
                "type": "boolean"
              }
            },
            "required": [
              "country",
              "country_code"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "address",
          "type": "object",
          "schema": "v202506.CustomerAddress",
          "has_id": true
        }
      ]
    },
    "address-delete": {
      "risk": "D",
      "module": "customers",
      "method": "DELETE",
      "path": "/customers/{customer_id}/addresses/{address_id}",
      "description": "Delete address",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "customer_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Customer ID"
              },
              "address_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Address ID"
              }
            },
            "required": [
              "customer_id",
              "address_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Delete a specific address using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "address-detail": {
      "risk": "R",
      "module": "customers",
      "method": "GET",
      "path": "/customers/{customer_id}/addresses/{address_id}",
      "description": "Get address",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "customer_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Customer ID"
              },
              "address_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Address ID"
              }
            },
            "required": [
              "customer_id",
              "address_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve details of a specific address using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "address",
          "type": "object",
          "schema": "v202506.CustomerAddress",
          "has_id": true
        }
      ]
    },
    "addresses": {
      "risk": "R",
      "module": "customers",
      "method": "GET",
      "path": "/customers/{customer_id}/addresses",
      "description": "List addresses",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "customer_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Customer ID"
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
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "Number of records per page. The default value is 10, and the maximum allowed value is 250"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve a list of all address with pagination. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "addresses",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.CustomerAddress"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "address-default-update": {
      "risk": "W",
      "module": "customers",
      "method": "PUT",
      "path": "/customers/{customer_id}/addresses/{address_id}/default",
      "description": "Set default address",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "customer_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Customer ID"
              },
              "address_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Address ID"
              }
            },
            "required": [
              "customer_id",
              "address_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Sets the specified address as the customer's default address. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "address-update": {
      "risk": "W",
      "module": "customers",
      "method": "PUT",
      "path": "/customers/{customer_id}/addresses/{address_id}",
      "description": "Update address",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "customer_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Customer ID"
              },
              "address_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Address ID"
              }
            },
            "required": [
              "customer_id",
              "address_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "address": {
                "$ref": "#/$defs/v202506.UpdateAddressParam",
                "description": "Address"
              }
            },
            "required": [
              "address"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update the details of an existing address using its unique identifier. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateAddressParam": {
            "type": "object",
            "properties": {
              "first_name": {
                "type": "string",
                "maxLength": 262144
              },
              "last_name": {
                "type": "string",
                "maxLength": 262144
              },
              "email": {
                "type": "string",
                "maxLength": 262144
              },
              "address1": {
                "type": "string",
                "maxLength": 262144
              },
              "address2": {
                "type": "string",
                "maxLength": 262144
              },
              "area": {
                "type": "string",
                "maxLength": 262144
              },
              "city": {
                "type": "string",
                "maxLength": 262144
              },
              "province": {
                "type": "string",
                "maxLength": 262144
              },
              "province_code": {
                "type": "string",
                "maxLength": 262144
              },
              "country": {
                "type": "string",
                "maxLength": 262144
              },
              "country_code": {
                "type": "string",
                "maxLength": 262144
              },
              "company": {
                "type": "string",
                "maxLength": 262144
              },
              "phone": {
                "type": "string",
                "maxLength": 262144
              },
              "phone_area_code": {
                "type": "string",
                "maxLength": 262144
              },
              "zip": {
                "type": "string",
                "maxLength": 262144
              },
              "gender": {
                "type": "string",
                "maxLength": 262144
              },
              "default": {
                "type": "boolean"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "address",
          "type": "object",
          "schema": "v202506.CustomerAddress",
          "has_id": true
        }
      ]
    },
    "customer-count": {
      "risk": "R",
      "module": "customers",
      "method": "GET",
      "path": "/customers/count",
      "description": "Get customer count",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve the total number of customers. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "customer-create": {
      "risk": "W",
      "module": "customers",
      "method": "POST",
      "path": "/customers",
      "description": "Create customer",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "customer": {
                "$ref": "#/$defs/v202506.CreateCustomerParam",
                "description": "Customer"
              }
            },
            "required": [
              "customer"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a new customer with the provided details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateCustomerParam": {
            "type": "object",
            "properties": {
              "contact_type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "first_name": {
                "type": "string",
                "maxLength": 262144
              },
              "last_name": {
                "type": "string",
                "maxLength": 262144
              },
              "password": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 6
              },
              "password_confirmation": {
                "type": "string",
                "maxLength": 262144
              },
              "tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 25
              },
              "registered_at": {
                "type": "string",
                "maxLength": 262144
              },
              "addresses": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.CreateAddressParam"
                },
                "maxItems": 25
              },
              "email": {
                "type": "string",
                "maxLength": 262144
              },
              "phone": {
                "type": "string",
                "maxLength": 262144
              },
              "accepts_marketing": {
                "type": "boolean",
                "default": true
              },
              "accepts_sms_marketing": {
                "type": "boolean",
                "default": true
              }
            },
            "required": [
              "contact_type"
            ],
            "additionalProperties": false
          },
          "v202506.CreateAddressParam": {
            "type": "object",
            "properties": {
              "country": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "country_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "first_name": {
                "type": "string",
                "maxLength": 262144
              },
              "last_name": {
                "type": "string",
                "maxLength": 262144
              },
              "address1": {
                "type": "string",
                "maxLength": 262144
              },
              "address2": {
                "type": "string",
                "maxLength": 262144
              },
              "area": {
                "type": "string",
                "maxLength": 262144
              },
              "city": {
                "type": "string",
                "maxLength": 262144
              },
              "province": {
                "type": "string",
                "maxLength": 262144
              },
              "province_code": {
                "type": "string",
                "maxLength": 262144
              },
              "company": {
                "type": "string",
                "maxLength": 262144
              },
              "phone": {
                "type": "string",
                "maxLength": 262144
              },
              "phone_area_code": {
                "type": "string",
                "maxLength": 262144
              },
              "zip": {
                "type": "string",
                "maxLength": 262144
              },
              "gender": {
                "type": "string",
                "maxLength": 262144
              },
              "email": {
                "type": "string",
                "maxLength": 262144
              },
              "default": {
                "type": "boolean"
              }
            },
            "required": [
              "country",
              "country_code"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "customer",
          "type": "object",
          "schema": "v202506.Customer",
          "has_id": true
        }
      ]
    },
    "customer-detail": {
      "risk": "R",
      "module": "customers",
      "method": "GET",
      "path": "/customers/{customer_id}",
      "description": "Get customer",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "customer_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Customer ID"
              }
            },
            "required": [
              "customer_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve details of a specific customer using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "customer",
          "type": "object",
          "schema": "v202506.Customer",
          "has_id": true
        }
      ]
    },
    "customers": {
      "risk": "R",
      "module": "customers",
      "method": "GET",
      "path": "/customers",
      "description": "List customers",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "The cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "The number of customers to retrieve per page. The default is 10, and the maximum is 250"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "A list of customer IDs. Example: ?ids=1001&ids=1002"
              },
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Retrieve customers created after this date. It's in UTC (0 timezone), formatted as ISO-8601"
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Retrieve customers created before this date. It's in UTC (0 timezone), formatted as ISO-8601"
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Retrieve customers last updated after this date. It's in UTC (0 timezone), formatted as ISO-8601"
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Retrieve customers last updated before this date. It's in UTC (0 timezone), formatted as ISO-8601"
              },
              "email": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter customers by email"
              },
              "contact": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter customers by contact information (email or phone)"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve a list of all customers with pagination. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "customers",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Customer"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "customer-update": {
      "risk": "W",
      "module": "customers",
      "method": "PUT",
      "path": "/customers/{customer_id}",
      "description": "Update customer",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "customer_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Customer ID"
              }
            },
            "required": [
              "customer_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "customer": {
                "$ref": "#/$defs/v202506.UpdateCustomerParam",
                "description": "The object containing customer attributes to be updated"
              }
            },
            "required": [
              "customer"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update the details of an existing customer using its unique identifier. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateCustomerParam": {
            "type": "object",
            "properties": {
              "first_name": {
                "type": "string",
                "maxLength": 262144
              },
              "last_name": {
                "type": "string",
                "maxLength": 262144
              },
              "accepts_marketing": {
                "type": "boolean"
              },
              "accepts_sms_marketing": {
                "type": "boolean"
              },
              "tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 25
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "customer",
          "type": "object",
          "schema": "v202506.Customer",
          "has_id": true
        }
      ]
    },
    "discount-batch-delete": {
      "risk": "D",
      "module": "discounts",
      "method": "POST",
      "path": "/discounts/batch-delete",
      "description": "Batch delete discounts",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "Discount IDs. Only discounts with progress status finished can be deleted"
              }
            },
            "required": [
              "ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Deletes multiple discounts by IDs. Only discounts with progress status finished can be deleted. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "discount-cancel": {
      "risk": "D",
      "module": "discounts",
      "method": "POST",
      "path": "/discounts/cancel",
      "description": "Cancel discounts",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "Discount IDs"
              }
            },
            "required": [
              "ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Cancels one or more discounts. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "discount-combine-update": {
      "risk": "H",
      "module": "discounts",
      "method": "PUT",
      "path": "/discounts/combine",
      "description": "Configure which discount types can be combined",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "Discount IDs"
              },
              "discount_combines": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "description": "Other discount categories that can be combined: - `product`: Can combine with product discounts - `order`: Can combine with order discounts - `shipping`: Can combine with shipping discounts"
              }
            },
            "required": [
              "ids",
              "discount_combines"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Configure which discount types can be combined. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "ids",
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ]
    },
    "coupon-create": {
      "risk": "H",
      "module": "discounts",
      "method": "POST",
      "path": "/coupons",
      "description": "Create coupon",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "coupon": {
                "$ref": "#/$defs/v202601.request.CreateCouponParam",
                "description": "Coupon payload"
              }
            },
            "required": [
              "coupon"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Creates a coupon campaign. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.request.CreateCouponParam": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "remarks": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "life_cycle_type": {
                "type": "string",
                "maxLength": 262144
              },
              "starts_at": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "x-integer-minimum": "0"
              },
              "ends_at": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -1,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "x-integer-minimum": "-1"
              },
              "use_coupon_starts_at": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "x-integer-minimum": "0"
              },
              "use_coupon_ends_at": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -1,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "x-integer-minimum": "-1"
              },
              "survival_time": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "x-integer-minimum": "0"
              },
              "discount_type": {
                "type": "string",
                "maxLength": 262144
              },
              "value": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "value_type": {
                "type": "string",
                "maxLength": 262144
              },
              "unlimited_usage": {
                "type": "boolean"
              },
              "stock": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "once_per_customer": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483647
              },
              "user_with_other": {
                "type": "boolean"
              },
              "prerequisite_subtotal_range": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.request.ThresholdRange"
                },
                "maxItems": 10
              },
              "prerequisite_quantity_range": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.request.ThresholdRange"
                },
                "maxItems": 10
              },
              "entitled_product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "entitled_collection_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "prerequisite_customer_segment_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "prerequisite_customer_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "sort": {
                "$ref": "#/$defs/v202601.request.CouponSort"
              },
              "config": {
                "$ref": "#/$defs/v202601.request.Config"
              }
            },
            "required": [
              "title",
              "remarks",
              "life_cycle_type",
              "starts_at",
              "ends_at",
              "use_coupon_starts_at",
              "use_coupon_ends_at",
              "survival_time",
              "discount_type",
              "value",
              "value_type",
              "stock",
              "once_per_customer",
              "user_with_other"
            ],
            "additionalProperties": false
          },
          "v202601.request.ThresholdRange": {
            "type": "object",
            "properties": {
              "greater_than_or_equal_to": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "value": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.CouponSort": {
            "type": "object",
            "properties": {
              "by": {
                "type": "string",
                "maxLength": 262144
              },
              "direction": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.Config": {
            "type": "object",
            "properties": {
              "banner_url": {
                "type": "string",
                "maxLength": 262144
              },
              "count_down": {
                "$ref": "#/$defs/v202601.request.CountDown"
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.CountDown": {
            "type": "object",
            "properties": {
              "background_color_end": {
                "type": "string",
                "maxLength": 262144
              },
              "background_color_start": {
                "type": "string",
                "maxLength": 262144
              },
              "color": {
                "type": "string",
                "maxLength": 262144
              },
              "count_down_background_color": {
                "type": "string",
                "maxLength": 262144
              },
              "count_down_color": {
                "type": "string",
                "maxLength": 262144
              },
              "detail_page_show_code": {
                "type": "boolean"
              },
              "show_count_down": {
                "type": "boolean"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "coupon",
          "type": "object",
          "schema": "v202601.response.Coupon",
          "has_id": true
        }
      ]
    },
    "coupon-detail": {
      "risk": "R",
      "module": "discounts",
      "method": "GET",
      "path": "/coupons/{id}",
      "description": "Get coupon",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Coupon ID"
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
        "additionalProperties": false,
        "description": "Gets coupon campaign details by ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "coupon",
          "type": "object",
          "schema": "v202601.response.Coupon",
          "has_id": true
        }
      ]
    },
    "coupon-update": {
      "risk": "H",
      "module": "discounts",
      "method": "PUT",
      "path": "/coupons/{id}",
      "description": "Update coupon",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Coupon ID. Read from the URL path"
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
              "coupon": {
                "$ref": "#/$defs/v202601.request.UpdateCouponParam",
                "description": "Updated coupon payload"
              }
            },
            "required": [
              "coupon"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Updates an existing coupon campaign by ID. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.request.UpdateCouponParam": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "remarks": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "starts_at": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "ends_at": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -1,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "x-integer-minimum": "-1"
              },
              "use_coupon_starts_at": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "use_coupon_ends_at": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -1,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "x-integer-minimum": "-1"
              },
              "survival_time": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "unlimited_usage": {
                "type": "boolean"
              },
              "stock": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483647
              },
              "sort": {
                "$ref": "#/$defs/v202601.request.CouponSort"
              },
              "config": {
                "$ref": "#/$defs/v202601.request.Config"
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.CouponSort": {
            "type": "object",
            "properties": {
              "by": {
                "type": "string",
                "maxLength": 262144
              },
              "direction": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.Config": {
            "type": "object",
            "properties": {
              "banner_url": {
                "type": "string",
                "maxLength": 262144
              },
              "count_down": {
                "$ref": "#/$defs/v202601.request.CountDown"
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.CountDown": {
            "type": "object",
            "properties": {
              "background_color_end": {
                "type": "string",
                "maxLength": 262144
              },
              "background_color_start": {
                "type": "string",
                "maxLength": 262144
              },
              "color": {
                "type": "string",
                "maxLength": 262144
              },
              "count_down_background_color": {
                "type": "string",
                "maxLength": 262144
              },
              "count_down_color": {
                "type": "string",
                "maxLength": 262144
              },
              "detail_page_show_code": {
                "type": "boolean"
              },
              "show_count_down": {
                "type": "boolean"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "coupon",
          "type": "object",
          "schema": "v202601.response.Coupon",
          "has_id": true
        }
      ]
    },
    "discount-automatic-create": {
      "risk": "H",
      "module": "discounts",
      "method": "POST",
      "path": "/discounts/automatic",
      "description": "Create automatic discount",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "discount": {
                "$ref": "#/$defs/v202601.request.CreateAutomaticDiscountParam",
                "description": "Discount data for automatic mode"
              }
            },
            "required": [
              "discount"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Creates an automatic discount. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.request.CreateAutomaticDiscountParam": {
            "type": "object",
            "properties": {
              "discount_info": {
                "$ref": "#/$defs/v202601.request.CreateAutomaticDiscountInfoReq"
              },
              "entitled_customer": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledCustomerReq"
              },
              "entitled_product": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledProductReq"
              },
              "discount_rule": {
                "$ref": "#/$defs/v202601.request.CreateAutomaticDiscountRuleReq"
              },
              "discount_layer": {
                "$ref": "#/$defs/v202601.request.CreateAutomaticDiscountLayerReq"
              }
            },
            "required": [
              "discount_info",
              "discount_layer"
            ],
            "additionalProperties": false
          },
          "v202601.request.CreateAutomaticDiscountInfoReq": {
            "type": "object",
            "properties": {
              "discount_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "display_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "discount_target": {
                "type": "string",
                "maxLength": 262144
              },
              "discount_type": {
                "type": "string",
                "maxLength": 262144
              },
              "starts_at": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483647
              },
              "ends_at": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              }
            },
            "required": [
              "discount_name",
              "display_name",
              "discount_target",
              "discount_type",
              "starts_at",
              "ends_at"
            ],
            "additionalProperties": false
          },
          "v202601.request.DiscountEntitledCustomerReq": {
            "type": "object",
            "properties": {
              "customer_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "customer_segment_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.DiscountEntitledProductReq": {
            "type": "object",
            "properties": {
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "variant_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "collection_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "sort": {
                "$ref": "#/$defs/v202601.request.Sort"
              },
              "selection": {
                "type": "string",
                "maxLength": 262144
              },
              "sku_extends": {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/$defs/v202601.request.SkuExtendReq"
                }
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.Sort": {
            "type": "object",
            "properties": {
              "by": {
                "type": "string",
                "maxLength": 262144
              },
              "direction": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.SkuExtendReq": {
            "type": "object",
            "properties": {
              "obtain_value": {
                "type": "string",
                "maxLength": 262144
              },
              "min_purchase_qty": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              },
              "seq": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              },
              "virtual_sales": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "follow_stock": {
                "type": "string",
                "maxLength": 262144
              },
              "stock": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.CreateAutomaticDiscountRuleReq": {
            "type": "object",
            "properties": {
              "limit_max_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_user_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_order_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_user_product_type": {
                "type": "string",
                "maxLength": 262144
              },
              "limit_user_product_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "price_rule": {
                "type": "string",
                "maxLength": 262144
              },
              "product_discount_order": {
                "type": "string",
                "maxLength": 262144
              },
              "virtual_sales": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483647
              },
              "stock": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "follow_stock": {
                "type": "string",
                "maxLength": 262144
              },
              "discount_combines": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "mn_discount_scope": {
                "type": "string",
                "maxLength": 262144
              },
              "enable_product_extends": {
                "type": "boolean"
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.CreateAutomaticDiscountLayerReq": {
            "type": "object",
            "properties": {
              "condition_type": {
                "type": "string",
                "maxLength": 262144
              },
              "obtain_type": {
                "type": "string",
                "maxLength": 262144
              },
              "layers": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.request.CreateAutomaticDiscountLayerItemReq"
                },
                "maxItems": 10
              }
            },
            "required": [
              "obtain_type"
            ],
            "additionalProperties": false
          },
          "v202601.request.CreateAutomaticDiscountLayerItemReq": {
            "type": "object",
            "properties": {
              "condition_value": {
                "type": "string",
                "maxLength": 262144
              },
              "obtain_value": {
                "type": "string",
                "maxLength": 262144
              },
              "obtain_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "discount",
          "type": "object",
          "schema": "v202601.response.DiscountDetail"
        }
      ]
    },
    "discount-non-automatic-create": {
      "risk": "H",
      "module": "discounts",
      "method": "POST",
      "path": "/discounts/non-automatic",
      "description": "Create non-automatic discount",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "discount": {
                "$ref": "#/$defs/v202601.request.CreateNonAutomaticDiscountParam",
                "description": "Discount data for non-automatic mode"
              }
            },
            "required": [
              "discount"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Creates a non-automatic discount. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.request.CreateNonAutomaticDiscountParam": {
            "type": "object",
            "properties": {
              "discount_info": {
                "$ref": "#/$defs/v202601.request.CreateNonAutomaticDiscountInfoReq"
              },
              "entitled_customer": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledCustomerReq"
              },
              "entitled_product": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledProductReq"
              },
              "discount_rule": {
                "$ref": "#/$defs/v202601.request.NonAutomaticDiscountRuleReq"
              },
              "discount_layer": {
                "$ref": "#/$defs/v202601.request.CreateNonAutomaticDiscountLayerReq"
              },
              "entitled_area": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledAreaReq"
              },
              "obtain_product": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledProductReq"
              }
            },
            "required": [
              "discount_info",
              "discount_layer"
            ],
            "additionalProperties": false
          },
          "v202601.request.CreateNonAutomaticDiscountInfoReq": {
            "type": "object",
            "properties": {
              "discount_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "display_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "discount_target": {
                "type": "string",
                "maxLength": 262144
              },
              "discount_type": {
                "type": "string",
                "maxLength": 262144
              },
              "discount_codes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1
              },
              "starts_at": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483647
              },
              "ends_at": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              }
            },
            "required": [
              "discount_name",
              "display_name",
              "discount_target",
              "discount_type",
              "discount_codes",
              "starts_at",
              "ends_at"
            ],
            "additionalProperties": false
          },
          "v202601.request.DiscountEntitledCustomerReq": {
            "type": "object",
            "properties": {
              "customer_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "customer_segment_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.DiscountEntitledProductReq": {
            "type": "object",
            "properties": {
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "variant_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "collection_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "sort": {
                "$ref": "#/$defs/v202601.request.Sort"
              },
              "selection": {
                "type": "string",
                "maxLength": 262144
              },
              "sku_extends": {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/$defs/v202601.request.SkuExtendReq"
                }
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.Sort": {
            "type": "object",
            "properties": {
              "by": {
                "type": "string",
                "maxLength": 262144
              },
              "direction": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.SkuExtendReq": {
            "type": "object",
            "properties": {
              "obtain_value": {
                "type": "string",
                "maxLength": 262144
              },
              "min_purchase_qty": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              },
              "seq": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              },
              "virtual_sales": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "follow_stock": {
                "type": "string",
                "maxLength": 262144
              },
              "stock": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.NonAutomaticDiscountRuleReq": {
            "type": "object",
            "properties": {
              "limit_max_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_user_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_order_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_code_max_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_code_user_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "obtain_full": {
                "type": "boolean"
              },
              "discount_combines": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.CreateNonAutomaticDiscountLayerReq": {
            "type": "object",
            "properties": {
              "condition_type": {
                "type": "string",
                "maxLength": 262144
              },
              "obtain_type": {
                "type": "string",
                "maxLength": 262144
              },
              "layers": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.request.CreateNonAutomaticDiscountLayerItemReq"
                },
                "maxItems": 10,
                "minItems": 1
              }
            },
            "required": [
              "condition_type",
              "obtain_type",
              "layers"
            ],
            "additionalProperties": false
          },
          "v202601.request.CreateNonAutomaticDiscountLayerItemReq": {
            "type": "object",
            "properties": {
              "condition_value": {
                "type": "string",
                "maxLength": 262144
              },
              "obtain_value": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "obtain_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              }
            },
            "required": [
              "obtain_value"
            ],
            "additionalProperties": false
          },
          "v202601.request.DiscountEntitledAreaReq": {
            "type": "object",
            "properties": {
              "areas": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.request.DiscountAreaReq"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.DiscountAreaReq": {
            "type": "object",
            "properties": {
              "country_code": {
                "type": "string",
                "maxLength": 262144
              },
              "province_codes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "discount",
          "type": "object",
          "schema": "v202601.response.DiscountDetail"
        }
      ]
    },
    "discount-delete": {
      "risk": "D",
      "module": "discounts",
      "method": "DELETE",
      "path": "/discounts/{id}",
      "description": "Delete discount",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Discount ID"
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
        "additionalProperties": false,
        "description": "Deletes a discount by ID. Only discounts with progress status finished can be deleted. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "discount-detail": {
      "risk": "R",
      "module": "discounts",
      "method": "GET",
      "path": "/discounts/{id}",
      "description": "Get discount",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Discount ID to query"
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
        "additionalProperties": false,
        "description": "Gets discount details by ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "discount",
          "type": "object",
          "schema": "v202601.response.DiscountDetail"
        }
      ]
    },
    "discount-by-code": {
      "risk": "R",
      "module": "discounts",
      "method": "GET",
      "path": "/discounts/by-code/{discount_code}",
      "description": "Get discount by code",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "discount_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Discount code used for lookup, read from URL path"
              }
            },
            "required": [
              "discount_code"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Gets a discount by discount code. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "discount",
          "type": "object",
          "schema": "v202601.response.DiscountDetail"
        }
      ]
    },
    "discounts": {
      "risk": "R",
      "module": "discounts",
      "method": "GET",
      "path": "/discounts",
      "description": "List discounts",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination, use the cursor from the response to retrieve the next page"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "A limit on the number of objects to be returned. Ranges from 1 to 250. Default is 10"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "discount_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Fuzzy match keyword for discount name"
              },
              "discount_type": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Discount types used as filter values. - rebate_cta_otr: Amount-threshold fixed reduction. - rebate_ctq_otr: Quantity-threshold fixed reduction. - rebate_cta_otp: Amount-threshold percentage discount. - rebate_ctq_otp: Quantity-threshold percentage discount. - m_n_discount: M-for-N discount. - flashsale: Flash sale discount. - code_percent: Discount-code percentage discount. - code_fix_price_reduction: Discount-code fixed reduction. - code_bxgy: Discount-code buy X get Y. - code_free_shipping: Discount-code free shipping. Example: ?discount_type=rebate_cta_otr&discount_type=rebate_ctq_otr"
              },
              "progress": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Discount progress states used as filter values. - ongoing: Ongoing. - not_started: Not started. - finished: Finished. - paused: Paused. Example: ?progress=ongoing&progress=finished"
              },
              "starts_date": {
                "type": "string",
                "maxLength": 262144,
                "description": "Lower bound datetime for time-overlap filtering, format as \"2006-01-02 15:04:05\""
              },
              "ends_date": {
                "type": "string",
                "maxLength": 262144,
                "description": "Upper bound datetime for time-overlap filtering, format as \"2006-01-02 15:04:05\""
              },
              "discount_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Discount code"
              },
              "discount_methods": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Discount methods used as filter values. - automatic: Applied automatically. - discount_code: Applied by discount code. Example: ?discount_methods=automatic&discount_methods=discount_code"
              },
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Explicit discount IDs used as filter values. Example: ?ids=1001&ids=1002"
              },
              "discount_targets": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Discount target categories used as filter values. - product: Product discount. - order: Order discount. - shipping: Shipping discount. Example: ?discount_targets=product&discount_targets=order"
              },
              "source_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Business source IDs used as filter values. - 1: Manual creation. - 2: Goaffpro Affiliate Marketing. - 3: Fintouch. - 4: MambaSMS SMS & Marketing. - 5: Stamped Loyalty & Referrals. - 6: Product recommendation. - 999: Other. Example: ?source_ids=3001&source_ids=3002"
              },
              "discount_combines": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Other discount categories that can be combined. - product: Can combine with product discounts. - order: Can combine with order discounts. - shipping: Can combine with shipping discounts. Example: ?discount_combines=product&discount_combines=shipping"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Returns the discount list by query parameters. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "discounts",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.response.DiscountSummaryResp"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "total_count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "discount-restart": {
      "risk": "H",
      "module": "discounts",
      "method": "POST",
      "path": "/discounts/restart",
      "description": "Restart discount",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Discount ID"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Restarts a discount. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "discount-automatic-update": {
      "risk": "H",
      "module": "discounts",
      "method": "PUT",
      "path": "/discounts/automatic/{id}",
      "description": "Update automatic discount",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Discount ID"
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
              "discount": {
                "$ref": "#/$defs/v202601.request.UpdateAutomaticDiscountParam",
                "description": "Discount data for automatic mode"
              }
            },
            "required": [
              "discount"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Updates an automatic discount by ID. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.request.UpdateAutomaticDiscountParam": {
            "type": "object",
            "properties": {
              "discount_info": {
                "$ref": "#/$defs/v202601.request.UpdateAutomaticDiscountInfoReq"
              },
              "entitled_customer": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledCustomerReq"
              },
              "entitled_product": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledProductReq"
              },
              "discount_rule": {
                "$ref": "#/$defs/v202601.request.UpdateAutomaticDiscountRuleReq"
              },
              "discount_layer": {
                "$ref": "#/$defs/v202601.request.UpdateDiscountLayerReq"
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.UpdateAutomaticDiscountInfoReq": {
            "type": "object",
            "properties": {
              "discount_name": {
                "type": "string",
                "maxLength": 262144
              },
              "display_name": {
                "type": "string",
                "maxLength": 262144
              },
              "starts_at": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "ends_at": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.DiscountEntitledCustomerReq": {
            "type": "object",
            "properties": {
              "customer_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "customer_segment_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.DiscountEntitledProductReq": {
            "type": "object",
            "properties": {
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "variant_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "collection_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "sort": {
                "$ref": "#/$defs/v202601.request.Sort"
              },
              "selection": {
                "type": "string",
                "maxLength": 262144
              },
              "sku_extends": {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/$defs/v202601.request.SkuExtendReq"
                }
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.Sort": {
            "type": "object",
            "properties": {
              "by": {
                "type": "string",
                "maxLength": 262144
              },
              "direction": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.SkuExtendReq": {
            "type": "object",
            "properties": {
              "obtain_value": {
                "type": "string",
                "maxLength": 262144
              },
              "min_purchase_qty": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              },
              "seq": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              },
              "virtual_sales": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "follow_stock": {
                "type": "string",
                "maxLength": 262144
              },
              "stock": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.UpdateAutomaticDiscountRuleReq": {
            "type": "object",
            "properties": {
              "limit_max_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_user_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_order_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_user_product_type": {
                "type": "string",
                "maxLength": 262144
              },
              "limit_user_product_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "price_rule": {
                "type": "string",
                "maxLength": 262144
              },
              "product_discount_order": {
                "type": "string",
                "maxLength": 262144
              },
              "virtual_sales": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483647
              },
              "stock": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "follow_stock": {
                "type": "string",
                "maxLength": 262144
              },
              "discount_combines": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "mn_discount_scope": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.UpdateDiscountLayerReq": {
            "type": "object",
            "properties": {
              "condition_type": {
                "type": "string",
                "maxLength": 262144
              },
              "obtain_type": {
                "type": "string",
                "maxLength": 262144
              },
              "layers": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.request.UpdateLayerItemReq"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.UpdateLayerItemReq": {
            "type": "object",
            "properties": {
              "condition_value": {
                "type": "string",
                "maxLength": 262144
              },
              "obtain_value": {
                "type": "string",
                "maxLength": 262144
              },
              "obtain_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "discount",
          "type": "object",
          "schema": "v202601.response.DiscountDetail"
        }
      ]
    },
    "discount-non-automatic-update": {
      "risk": "H",
      "module": "discounts",
      "method": "PUT",
      "path": "/discounts/non-automatic/{id}",
      "description": "Update non-automatic discount",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Discount ID"
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
              "discount": {
                "$ref": "#/$defs/v202601.request.UpdateNonAutomaticDiscountParam",
                "description": "Discount data for non-automatic mode"
              }
            },
            "required": [
              "discount"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Updates a non-automatic discount by ID. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.request.UpdateNonAutomaticDiscountParam": {
            "type": "object",
            "properties": {
              "discount_info": {
                "$ref": "#/$defs/v202601.request.UpdateNonAutomaticDiscountInfoReq"
              },
              "entitled_customer": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledCustomerReq"
              },
              "entitled_product": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledProductReq"
              },
              "discount_rule": {
                "$ref": "#/$defs/v202601.request.NonAutomaticDiscountRuleReq"
              },
              "discount_layer": {
                "$ref": "#/$defs/v202601.request.UpdateDiscountLayerReq"
              },
              "entitled_area": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledAreaReq"
              },
              "obtain_product": {
                "$ref": "#/$defs/v202601.request.DiscountEntitledProductReq"
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.UpdateNonAutomaticDiscountInfoReq": {
            "type": "object",
            "properties": {
              "discount_name": {
                "type": "string",
                "maxLength": 262144
              },
              "display_name": {
                "type": "string",
                "maxLength": 262144
              },
              "discount_codes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "starts_at": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "ends_at": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.DiscountEntitledCustomerReq": {
            "type": "object",
            "properties": {
              "customer_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "customer_segment_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.DiscountEntitledProductReq": {
            "type": "object",
            "properties": {
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "variant_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "collection_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "sort": {
                "$ref": "#/$defs/v202601.request.Sort"
              },
              "selection": {
                "type": "string",
                "maxLength": 262144
              },
              "sku_extends": {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/$defs/v202601.request.SkuExtendReq"
                }
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.Sort": {
            "type": "object",
            "properties": {
              "by": {
                "type": "string",
                "maxLength": 262144
              },
              "direction": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.SkuExtendReq": {
            "type": "object",
            "properties": {
              "obtain_value": {
                "type": "string",
                "maxLength": 262144
              },
              "min_purchase_qty": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              },
              "seq": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              },
              "virtual_sales": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "follow_stock": {
                "type": "string",
                "maxLength": 262144
              },
              "stock": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.NonAutomaticDiscountRuleReq": {
            "type": "object",
            "properties": {
              "limit_max_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_user_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_order_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_code_max_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "limit_code_user_discount": {
                "type": "integer",
                "minimum": -1,
                "maximum": 2147483647
              },
              "obtain_full": {
                "type": "boolean"
              },
              "discount_combines": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.UpdateDiscountLayerReq": {
            "type": "object",
            "properties": {
              "condition_type": {
                "type": "string",
                "maxLength": 262144
              },
              "obtain_type": {
                "type": "string",
                "maxLength": 262144
              },
              "layers": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.request.UpdateLayerItemReq"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.UpdateLayerItemReq": {
            "type": "object",
            "properties": {
              "condition_value": {
                "type": "string",
                "maxLength": 262144
              },
              "obtain_value": {
                "type": "string",
                "maxLength": 262144
              },
              "obtain_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.DiscountEntitledAreaReq": {
            "type": "object",
            "properties": {
              "areas": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.request.DiscountAreaReq"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.request.DiscountAreaReq": {
            "type": "object",
            "properties": {
              "country_code": {
                "type": "string",
                "maxLength": 262144
              },
              "province_codes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "discount",
          "type": "object",
          "schema": "v202601.response.DiscountDetail"
        }
      ]
    },
    "order-cancel": {
      "risk": "D",
      "module": "orders",
      "method": "POST",
      "path": "/orders/{order_id}/cancel",
      "description": "Cancel order",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
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
              "reason": {
                "type": "string",
                "maxLength": 262144,
                "description": "The reason for canceling the order"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Canceling an order by specifying its unique ID and an optional cancel reason. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "order",
          "type": "object",
          "schema": "v202506.Order",
          "has_id": true
        }
      ]
    },
    "order-count": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/count",
      "description": "Get order count",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by order IDs. Example: ?ids=1001&ids=1002"
              },
              "status": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter by order status. - opened: pending payment. - cancelled: cancelled. - placed: in progress. - finished: completed. Example: ?status=opened&status=finished"
              },
              "fulfillment_status": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter by order fulfillment status. - initialled: initial. - waiting: waiting to ship. - partially_shipped: partially shipped. - shipped: fully shipped. - partially_finished: partially received. - finished: fully received. - cancelled: cancelled. - returning: return in progress. - partially_returned: partially returned. - returned: fully returned. Example: ?fulfillment_status=waiting&fulfillment_status=shipped"
              },
              "financial_status": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter by payment status. - waiting: pending payment. - paying: payment under review. - authorized: authorized. - partially_paid: partially paid. - paid: paid. - cancelled: cancelled. - failed: payment failed. - refunding: refund in progress. - refund_failed: refund failed. - refunded: fully refunded. - partially_refunded: partially refunded. Example: ?financial_status=waiting&financial_status=paid"
              },
              "recovery_status": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by cart recovery status: - `waiting`: waiting to be recalled - `sending`: recall notification in progress - `recalling`: recall in progress - `failed`: recall failed - `success`: recall successful"
              },
              "location_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by location ID"
              },
              "keyword": {
                "type": "string",
                "maxLength": 262144,
                "description": "Keyword for searching orders"
              },
              "keyword_scope_fields": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Fields to apply keyword search on. Supported values: order_no, email, phone, name, etc. Example: ?keyword_scope_fields=order_no&keyword_scope_fields=email"
              },
              "customer_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by customer ID"
              },
              "total_min": {
                "type": "number",
                "description": "Filter orders with total greater than or equal to this value"
              },
              "total_max": {
                "type": "number",
                "description": "Filter orders with total less than or equal to this value"
              },
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders created after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders created before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders updated after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders updated before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "placed_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders placed after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "placed_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders placed before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "sales_platform": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by sales channel. Example: ?sales_platform=value1&sales_platform=value2"
              },
              "admin_hasfilter": {
                "type": "boolean",
                "description": "Apply the same has_filter logic as the admin-side incomplete order list: - `true`: apply filter - `false`: do not apply filter"
              },
              "finished_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders finished after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "finished_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders finished before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "fulfilled_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders fulfilled after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "fulfilled_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders fulfilled before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "last_referrer_show_created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by last touchpoint time start (e.g., 2018-11-02T12:30:10Z)"
              },
              "last_referrer_show_created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by last touchpoint time end (e.g., 2018-11-02T12:30:10Z)"
              },
              "source_name_created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by first touchpoint time start (e.g., 2018-11-02T12:30:10Z)"
              },
              "source_name_created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by first touchpoint time end (e.g., 2018-11-02T12:30:10Z)"
              },
              "shipping_emails": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by shipping address email. Example: ?shipping_emails=a@example.com&shipping_emails=b@example.com"
              },
              "shipping_phones": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by shipping address phone. Example: ?shipping_phones=13800000001&shipping_phones=13800000002"
              },
              "browser_ips": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by browser IP address. Example: ?browser_ips=1.2.3.4&browser_ips=5.6.7.8"
              },
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by product ID. Example: ?product_ids=2001&product_ids=2002"
              },
              "skus": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by SKU. Example: ?skus=SKU0001&skus=SKU0002"
              },
              "spus": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by SPU. Example: ?spus=SPU0001&spus=SPU0002"
              },
              "order_tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by order tag. Example: ?order_tags=vip&order_tags=new"
              },
              "customer_emails": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by customer email. Example: ?customer_emails=c@example.com&customer_emails=d@example.com"
              },
              "fuzzy_fields": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Field names to apply fuzzy matching on. Combined with fuzzy_keywords / fuzzy_relation Allowed values: - `name`: customer name (not recipient name) - `number`: order number - `id`: order ID - `sku`: product SKU (snapshot data). For exact match use `skus` - `spu`: product SPU (snapshot data). For exact match use `spus` - `tag_list`: order tags. For exact match use `order_tags` - `shipping_email`: shipping address email. For exact match use `shipping_emails` - `shipping_phone`: shipping address phone. For exact match use `shipping_phones` - `browser_ip`: order IP address. For exact match use `browser_ips` - `product_tags`: product tags (snapshot data) - `product_title`: product title (snapshot data) - `credit_card_number`: last 4 digits of the payment card - `source`: first-visit landing page - `source_name`: first-visit source - `tracking_number`: shipping tracking number - `shipping_line_name`: shipping plan name - `line_item_vendor`: product vendor - `discount_code`: discount code - `shipping_address_extra_info`: special shipping field info - `transaction_id`: payment transaction number - `customer_id`: customer ID - `last_landing_url`: last-visit landing page - `last_referrer_show`: last-visit source - `country`: country name (snapshot data; mixed CN/EN search not supported) - `shop_name`: POS shop name - `staff_contact`: POS staff Note: for fields that also have a dedicated exact-match array parameter (sku/spu/tag_list/shipping_email/shipping_phone/browser_ip), use the array parameter for full-value lookups; reserve fuzzy mode for prefix or fragment search. Example: ?fuzzy_fields=name&fuzzy_fields=number"
              },
              "fuzzy_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Fuzzy keyword list. Any keyword matches in any of fuzzy_fields counts as a hit. Example: ?fuzzy_keywords=iphone&fuzzy_keywords=vip"
              },
              "fuzzy_relation": {
                "type": "string",
                "maxLength": 262144,
                "description": "How fuzzy_fields entries are joined: \"and\" or \"or\". Defaults to \"or\""
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Provides the total number of orders matching the specified query parameters. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "order-create": {
      "risk": "H",
      "module": "orders",
      "method": "POST",
      "path": "/orders",
      "description": "Create order",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "order": {
                "$ref": "#/$defs/v202601.CreateOrderParam",
                "description": "Order"
              }
            },
            "required": [
              "order"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Merchants can use this feature to create orders on behalf of their customers. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.CreateOrderParam": {
            "type": "object",
            "properties": {
              "line_items": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.CreateOrderLineItemParam"
                },
                "maxItems": 10,
                "minItems": 1
              },
              "shipping_address": {
                "$ref": "#/$defs/v202601.CreateOrderShippingAddressParam"
              },
              "shipping_line": {
                "$ref": "#/$defs/v202601.CreateOrderShippingLineParam"
              },
              "tax_total": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "currency_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "discount": {
                "type": "string",
                "maxLength": 262144
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "payment_line": {
                "type": "string",
                "maxLength": 262144
              },
              "config": {
                "type": "string",
                "maxLength": 262144
              },
              "discount_application": {
                "$ref": "#/$defs/v202601.DiscountApplication"
              },
              "order_confirm_notify": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2
              },
              "fulfillment_notify": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2
              },
              "partial_fulfillment_notify": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2
              },
              "order_delivered_notify": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2
              },
              "custom_fields": {
                "type": "object",
                "additionalProperties": {
                  "type": "string",
                  "maxLength": 262144
                }
              }
            },
            "required": [
              "line_items",
              "shipping_address",
              "shipping_line",
              "tax_total",
              "currency_code"
            ],
            "additionalProperties": false
          },
          "v202601.CreateOrderLineItemParam": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144
              },
              "variant_id": {
                "type": "string",
                "maxLength": 262144
              },
              "quantity": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "price": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "use_discount": {
                "type": "boolean"
              },
              "product_title": {
                "type": "string",
                "maxLength": 262144
              },
              "total_price": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "quantity"
            ],
            "additionalProperties": false
          },
          "v202601.CreateOrderShippingAddressParam": {
            "type": "object",
            "properties": {
              "first_name": {
                "type": "string",
                "maxLength": 262144
              },
              "last_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "email": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "phone_area_code": {
                "type": "string",
                "maxLength": 262144
              },
              "phone": {
                "type": "string",
                "maxLength": 262144
              },
              "country": {
                "type": "string",
                "maxLength": 262144
              },
              "country_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "province": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "province_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "area": {
                "type": "string",
                "maxLength": 262144
              },
              "city": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "address": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "address1": {
                "type": "string",
                "maxLength": 262144
              },
              "company": {
                "type": "string",
                "maxLength": 262144
              },
              "zip": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "cpf": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "last_name",
              "email",
              "country_code",
              "province",
              "province_code",
              "city",
              "address",
              "zip"
            ],
            "additionalProperties": false
          },
          "v202601.CreateOrderShippingLineParam": {
            "type": "object",
            "properties": {
              "shipping_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "shipping_desc": {
                "type": "string",
                "maxLength": 262144
              },
              "shipping_price": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "delivery_method": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "business_info": {
                "$ref": "#/$defs/v202601.BusinessInfo"
              }
            },
            "required": [
              "shipping_name",
              "shipping_price"
            ],
            "additionalProperties": false
          },
          "v202601.BusinessInfo": {
            "type": "object",
            "properties": {
              "time_remark": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.DiscountApplication": {
            "type": "object",
            "properties": {
              "discount_code": {
                "type": "string",
                "maxLength": 262144
              },
              "title": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "order",
          "type": "object",
          "schema": "v202601.Order",
          "has_id": true
        }
      ]
    },
    "order-delete": {
      "risk": "D",
      "module": "orders",
      "method": "DELETE",
      "path": "/orders/{order_id}",
      "description": "Delete order",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Allows the deletion of a specific order by its unique ID. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "fulfillment-cancel": {
      "risk": "D",
      "module": "orders",
      "method": "POST",
      "path": "/orders/{order_id}/fulfillments/{fulfillment_id}/cancel",
      "description": "Cancel fulfillment",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              },
              "fulfillment_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Fulfillment ID to cancel"
              }
            },
            "required": [
              "order_id",
              "fulfillment_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Cancels a specific fulfillment for an order. This action marks the fulfillment as cancelled, stopping any further processing or shipping operations. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "fulfillment",
          "type": "object",
          "schema": "v202601.FulfillmentSummary",
          "has_id": true
        }
      ]
    },
    "fulfillment-complete": {
      "risk": "H",
      "module": "orders",
      "method": "POST",
      "path": "/orders/{order_id}/fulfillments/{fulfillment_id}/complete",
      "description": "Complete fulfillment",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              },
              "fulfillment_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Fulfillment ID to complete"
              }
            },
            "required": [
              "order_id",
              "fulfillment_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Marks a specific fulfillment as complete. If the fulfillment is already finished, the API retrieves and returns the fulfillment details instead. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "fulfillment",
          "type": "object",
          "schema": "v202601.FulfillmentSummary",
          "has_id": true
        }
      ]
    },
    "fulfillment-count": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/{order_id}/fulfillments/count",
      "description": "Get fulfillment count",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
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
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter fulfillments created at or after this date. ISO-8601 format, for example, \"2023-01-01T00:00:00Z\""
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter fulfillments created at or before this date. ISO-8601 format, for example, \"2023-01-01T00:00:00Z\""
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter fulfillments updated at or after this date. ISO-8601 format, for example, \"2023-01-01T00:00:00Z\""
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter fulfillments updated at or before this date. ISO-8601 format, for example, \"2023-01-01T00:00:00Z\""
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves the total number of fulfillments for a specific order. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "fulfillment-create": {
      "risk": "H",
      "module": "orders",
      "method": "POST",
      "path": "/orders/{order_id}/fulfillments",
      "description": "Create fulfillment",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
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
              "fulfillment": {
                "$ref": "#/$defs/v202506.CreateFulfillmentParam",
                "description": "Fulfillment data to create"
              }
            },
            "required": [
              "fulfillment"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Creates a fulfillment for specific order items and updates their shipping details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateFulfillmentParam": {
            "type": "object",
            "properties": {
              "line_items": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.FulfillmentLineItemParam"
                },
                "maxItems": 10,
                "minItems": 1
              },
              "tracking_number": {
                "type": "string",
                "maxLength": 262144
              },
              "tracking_company": {
                "type": "string",
                "maxLength": 262144
              },
              "tracking_company_code": {
                "type": "string",
                "maxLength": 262144
              },
              "tracking_url": {
                "type": "string",
                "maxLength": 262144
              },
              "phone_number": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "line_items"
            ],
            "additionalProperties": false
          },
          "v202506.FulfillmentLineItemParam": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "ship_quantity": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "fulfillment",
          "type": "object",
          "schema": "v202601.FulfillmentSummary",
          "has_id": true
        }
      ]
    },
    "fulfillment-detail": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/{order_id}/fulfillments/{fulfillment_id}",
      "description": "Get fulfillment",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              },
              "fulfillment_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Fulfillment ID to query"
              }
            },
            "required": [
              "order_id",
              "fulfillment_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves the details of a specific fulfillment for an order. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "fulfillment",
          "type": "object",
          "schema": "v202601.Fulfillment",
          "has_id": true
        }
      ]
    },
    "fulfillments": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/{order_id}/fulfillments",
      "description": "List fulfillments",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
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
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination, use the cursor from the response to retrieve the next page"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "A limit on the number of objects to be returned. Ranges from 1 to 250. Default is 10"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter fulfillments created at or after this date. ISO-8601 format, for example, \"2023-01-01T00:00:00Z\""
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter fulfillments created at or before this date. ISO-8601 format, for example, \"2023-01-01T00:00:00Z\""
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter fulfillments updated at or after this date. ISO-8601 format, for example, \"2023-01-01T00:00:00Z\""
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter fulfillments updated at or before this date. ISO-8601 format, for example, \"2023-01-01T00:00:00Z\""
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves a list of fulfillments for the order. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "fulfillments",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.FulfillmentSummary"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "fulfillment-update": {
      "risk": "H",
      "module": "orders",
      "method": "PUT",
      "path": "/orders/{order_id}/fulfillments/{fulfillment_id}",
      "description": "Update fulfillment",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              },
              "fulfillment_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Fulfillment ID to update"
              }
            },
            "required": [
              "order_id",
              "fulfillment_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "fulfillment": {
                "$ref": "#/$defs/v202506.UpdateFulfillmentParam",
                "description": "Fulfillment data to update"
              }
            },
            "required": [
              "fulfillment"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Updates the details of an existing fulfillment, including tracking information and notification preferences. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateFulfillmentParam": {
            "type": "object",
            "properties": {
              "tracking_number": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "tracking_company": {
                "type": "string",
                "maxLength": 262144
              },
              "tracking_company_code": {
                "type": "string",
                "maxLength": 262144
              },
              "tracking_url": {
                "type": "string",
                "maxLength": 262144
              },
              "send_email": {
                "type": "boolean"
              },
              "phone_number": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "fulfillment",
          "type": "object",
          "schema": "v202601.FulfillmentSummary",
          "has_id": true
        }
      ]
    },
    "order-detail": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/{order_id}",
      "description": "Get order",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves detailed information about a specific order based on its unique ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "order",
          "type": "object",
          "schema": "v202601.Order",
          "has_id": true
        }
      ]
    },
    "order-by-number": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/number/{number}",
      "description": "Get order details by number",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "number": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order number, intended to simplify merchant references"
              }
            },
            "required": [
              "number"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves detailed information about a specific order using its unique order number. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "order",
          "type": "object",
          "schema": "v202601.Order",
          "has_id": true
        }
      ]
    },
    "orders": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders",
      "description": "List orders",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "A limit on the number of objects to return. Range: 1-250 (default is 10)"
              },
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "List of IDs. Example: ?ids=1001&ids=1002"
              },
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders created after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders created before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders updated after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders updated before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "placed_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders placed after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "placed_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders placed before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "status": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter by order status. - opened: pending payment. - cancelled: cancelled. - placed: in progress. - finished: completed. Example: ?status=opened&status=finished"
              },
              "fulfillment_status": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter by order fulfillment status. - initialled: initial. - waiting: waiting to ship. - partially_shipped: partially shipped. - shipped: fully shipped. - partially_finished: partially received. - finished: fully received. - cancelled: cancelled. - returning: return in progress. - partially_returned: partially returned. - returned: fully returned. Example: ?fulfillment_status=waiting&fulfillment_status=shipped"
              },
              "financial_status": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter by payment status. - waiting: pending payment. - paying: payment under review. - authorized: authorized. - partially_paid: partially paid. - paid: paid. - cancelled: cancelled. - failed: payment failed. - refunding: refund in progress. - refund_failed: refund failed. - refunded: fully refunded. - partially_refunded: partially refunded. Example: ?financial_status=waiting&financial_status=paid"
              },
              "recovery_status": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by cart recovery status: - `waiting`: waiting to be recalled - `sending`: recall notification in progress - `recalling`: recall in progress - `failed`: recall failed - `success`: recall successful"
              },
              "location_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by location ID"
              },
              "keyword": {
                "type": "string",
                "maxLength": 262144,
                "description": "Keyword for searching orders"
              },
              "keyword_scope_fields": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Fields to apply keyword search on. Example: ?keyword_scope_fields=order_no&keyword_scope_fields=email"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sort field"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sort direction"
              },
              "customer_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by customer ID"
              },
              "total_min": {
                "type": "number",
                "description": "Filter orders with total greater than or equal to this value"
              },
              "total_max": {
                "type": "number",
                "description": "Filter orders with total less than or equal to this value"
              },
              "sales_platform": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by sales platform. Example: ?sales_platform=value1&sales_platform=value2"
              },
              "finished_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders finished after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "finished_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders finished before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "fulfilled_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders fulfilled after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "fulfilled_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders fulfilled before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "last_referrer_show_created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by last touchpoint time start (e.g., 2018-11-02T12:30:10Z)"
              },
              "last_referrer_show_created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by last touchpoint time end (e.g., 2018-11-02T12:30:10Z)"
              },
              "source_name_created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by first touchpoint time start (e.g., 2018-11-02T12:30:10Z)"
              },
              "source_name_created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter orders by first touchpoint time end (e.g., 2018-11-02T12:30:10Z)"
              },
              "shipping_emails": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by shipping address email. Example: ?shipping_emails=a@example.com&shipping_emails=b@example.com"
              },
              "shipping_phones": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by shipping address phone. Example: ?shipping_phones=13800000001&shipping_phones=13800000002"
              },
              "browser_ips": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by browser IP address. Example: ?browser_ips=1.2.3.4&browser_ips=5.6.7.8"
              },
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by product ID. Example: ?product_ids=2001&product_ids=2002"
              },
              "skus": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by SKU. Example: ?skus=SKU0001&skus=SKU0002"
              },
              "spus": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by SPU. Example: ?spus=SPU0001&spus=SPU0002"
              },
              "order_tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by order tag. Example: ?order_tags=vip&order_tags=new"
              },
              "customer_emails": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter orders by customer email. Example: ?customer_emails=c@example.com&customer_emails=d@example.com"
              },
              "fuzzy_fields": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Field names to apply fuzzy matching on. Combined with fuzzy_keywords / fuzzy_relation Allowed values: - `name`: customer name (not recipient name) - `number`: order number - `id`: order ID - `sku`: product SKU (snapshot data). For exact match use `skus` - `spu`: product SPU (snapshot data). For exact match use `spus` - `tag_list`: order tags. For exact match use `order_tags` - `shipping_email`: shipping address email. For exact match use `shipping_emails` - `shipping_phone`: shipping address phone. For exact match use `shipping_phones` - `browser_ip`: order IP address. For exact match use `browser_ips` - `product_tags`: product tags (snapshot data) - `product_title`: product title (snapshot data) - `credit_card_number`: last 4 digits of the payment card - `source`: first-visit landing page - `source_name`: first-visit source - `tracking_number`: shipping tracking number - `shipping_line_name`: shipping plan name - `line_item_vendor`: product vendor - `discount_code`: discount code - `shipping_address_extra_info`: special shipping field info - `transaction_id`: payment transaction number - `customer_id`: customer ID - `last_landing_url`: last-visit landing page - `last_referrer_show`: last-visit source - `country`: country name (snapshot data; mixed CN/EN search not supported) - `shop_name`: POS shop name - `staff_contact`: POS staff Note: for fields that also have a dedicated exact-match array parameter (sku/spu/tag_list/shipping_email/shipping_phone/browser_ip), use the array parameter for full-value lookups; reserve fuzzy mode for prefix or fragment search. Example: ?fuzzy_fields=name&fuzzy_fields=number"
              },
              "fuzzy_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Fuzzy keyword list. Any keyword matches in any of fuzzy_fields counts as a hit. Example: ?fuzzy_keywords=iphone&fuzzy_keywords=vip"
              },
              "fuzzy_relation": {
                "type": "string",
                "maxLength": 262144,
                "description": "How fuzzy_fields entries are joined: \"and\" or \"or\". Defaults to \"or\""
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Returns a paginated list of orders, with optional filters for status, date range, and other criteria. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "orders",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.Order"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "order-pay-success": {
      "risk": "H",
      "module": "orders",
      "method": "POST",
      "path": "/orders/{order_id}/payment/success",
      "description": "Pay order success",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
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
              "billing_address": {
                "$ref": "#/$defs/v202601.BillingAddressParam",
                "description": "The billing address details. If omitted, the existing billing address remains unchanged"
              },
              "gateway": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Payment gateway name; can be used to set a custom payment gateway name. See the API usage notes."
              },
              "payment_line": {
                "$ref": "#/$defs/v202601.PaymentLineParam",
                "description": "Payment line of the order. Specifies the actual payment channel, method, and transaction number."
              },
              "payment_lines": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.PaymentLineParam"
                },
                "maxItems": 10,
                "description": "List of payment lines"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Finalizes payment for an order and updates its status to indicate that payment has been completed.\nUsage:\n1. No params: default test payment (bogus), simulating a completed payment\n2. `payment_line` only: specify a real payment channel\nExample: {\"payment_line\":{\"payment_channel\":\"stripe\",\"payment_method\":\"credit_card\",\"transaction_no\":\"txn_xxx\"}}\n3. `gateway` only (+ optional `payment_line.transaction_no`): custom payment method (e.g. offline bank transfer)\nExample: {\"gateway\":\"bank_transfer\"}\nExample: {\"gateway\":\"bank_transfer\",\"payment_line\":{\"transaction_no\":\"txn_xxx\"}}\n4. Both `gateway` and `payment_line`: pay via the real channel in `payment_line`, with a custom display name from `gateway`\nExample: {\"gateway\":\"My Custom Name\",\"payment_line\":{\"payment_channel\":\"stripe\",\"payment_method\":\"credit_card\",\"transaction_no\":\"txn_xxx\"}} Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.BillingAddressParam": {
            "type": "object",
            "properties": {
              "first_name": {
                "type": "string",
                "maxLength": 262144
              },
              "last_name": {
                "type": "string",
                "maxLength": 262144
              },
              "email": {
                "type": "string",
                "maxLength": 262144
              },
              "country": {
                "type": "string",
                "maxLength": 262144
              },
              "country_code": {
                "type": "string",
                "maxLength": 262144
              },
              "province": {
                "type": "string",
                "maxLength": 262144
              },
              "province_code": {
                "type": "string",
                "maxLength": 262144
              },
              "area": {
                "type": "string",
                "maxLength": 262144
              },
              "city": {
                "type": "string",
                "maxLength": 262144
              },
              "address": {
                "type": "string",
                "maxLength": 262144
              },
              "address1": {
                "type": "string",
                "maxLength": 262144
              },
              "company": {
                "type": "string",
                "maxLength": 262144
              },
              "longitude": {
                "type": "string",
                "maxLength": 262144
              },
              "latitude": {
                "type": "string",
                "maxLength": 262144
              },
              "zip": {
                "type": "string",
                "maxLength": 262144
              },
              "source": {
                "type": "string",
                "maxLength": 262144
              },
              "tags": {
                "type": "string",
                "maxLength": 262144
              },
              "phone": {
                "type": "string",
                "maxLength": 262144
              },
              "phone_area_code": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.PaymentLineParam": {
            "type": "object",
            "properties": {
              "payment_method": {
                "type": "string",
                "maxLength": 262144
              },
              "payment_channel": {
                "type": "string",
                "maxLength": 262144
              },
              "transaction_no": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "credit_card_number": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "transaction_no"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "order",
          "type": "object",
          "schema": "v202506.Order",
          "has_id": true
        }
      ]
    },
    "order-post-sale-delete": {
      "risk": "D",
      "module": "orders",
      "method": "DELETE",
      "path": "/orders/post_sales/{post_sale_id}",
      "description": "Delete post-sale order",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "post_sale_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Post-sale ID"
              }
            },
            "required": [
              "post_sale_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Allows you to remove a specific post-sales order record (e.g., a return or exchange request) by its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "order-post-sales": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/post_sales",
      "description": "List post-sale orders",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 20,
                "description": "A limit on the number of objects to return. (default is 20)"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter to include records created on or after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter to include records created on or before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "Post-sale status: - `pending`: pending - `processing`: processing - `finished`: completed"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieves a list of after-sales records (e.g., returns or exchanges) associated with orders. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "orders",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.PostSaleOrder"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "order-refund-record-count": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/refund_records/count",
      "description": "Get refund records count",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "order_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "description": "Filter by order IDs. Up to 10 IDs are supported. Example: ?order_ids=1001&order_ids=1002"
              },
              "refund_order_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 20,
                "description": "Filter by refund record IDs. Up to 20 IDs are supported. Example: ?refund_order_ids=2001&refund_order_ids=2002"
              },
              "refund_statuses": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter by refund status. - pending: refund in progress. - finished: refund completed. - failed: refund failed. Example: ?refund_statuses=pending&refund_statuses=finished"
              },
              "created_at_start": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter records created at or after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "created_at_end": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter records created at or before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "updated_at_start": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter records last updated at or after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "updated_at_end": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter records last updated at or before this time (e.g., 2018-11-02T12:30:10Z)"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Returns the total number of refund records matching the same filters\naccepted by the list endpoint. Useful for paging UIs and dashboards. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "order-refund-record-create": {
      "risk": "H",
      "module": "orders",
      "method": "POST",
      "path": "/orders/{order_id}/refund",
      "description": "Create order refund record",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
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
              "refund": {
                "$ref": "#/$defs/v202506.CreateOrderRefundRecordParam",
                "description": "Refund request body including amounts, line items, payment channels, and notes"
              }
            },
            "required": [
              "refund"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Attaches a new refund record to the specified order, declaring how much\nto refund and on which payment channels. Returns the new refund record id\nand the associated after-sales (post-sale) record id. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateOrderRefundRecordParam": {
            "type": "object",
            "properties": {
              "refund_total": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "refund_shipping_total": {
                "type": "string",
                "maxLength": 262144
              },
              "refund_tip": {
                "type": "string",
                "maxLength": 262144
              },
              "refund_additional_total": {
                "type": "string",
                "maxLength": 262144
              },
              "refund_product_total": {
                "type": "string",
                "maxLength": 262144
              },
              "refund_line_items": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.CreateRefundRecordLineItemParam"
                },
                "maxItems": 10
              },
              "refund_payments": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.CreateRefundRecordPaymentParam"
                },
                "maxItems": 10
              },
              "refund_additional_prices": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.CreateRefundRecordAdditionalPriceParam"
                },
                "maxItems": 10
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "refund_total"
            ],
            "additionalProperties": false
          },
          "v202506.CreateRefundRecordLineItemParam": {
            "type": "object",
            "properties": {
              "line_item_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "refund_item_type": {
                "type": "string",
                "maxLength": 262144,
                "enum": [
                  "auto",
                  "shipped",
                  "waiting_ship"
                ]
              },
              "quantity": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "return_inventory": {
                "type": "boolean"
              }
            },
            "required": [
              "line_item_id"
            ],
            "additionalProperties": false
          },
          "v202506.CreateRefundRecordPaymentParam": {
            "type": "object",
            "properties": {
              "payment_line_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "refund_price": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "payment_line_id",
              "refund_price"
            ],
            "additionalProperties": false
          },
          "v202506.CreateRefundRecordAdditionalPriceParam": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "price": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "name",
              "price"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "refund_record_id",
          "type": "string"
        },
        {
          "name": "post_sale_id",
          "type": "string"
        }
      ]
    },
    "order-refund-finish": {
      "risk": "H",
      "module": "orders",
      "method": "POST",
      "path": "/orders/{order_id}/refund/finish",
      "description": "Finish refund",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
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
              "post_sale_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "After-sales (post-sale) record ID"
              },
              "refund_record_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Refund record ID"
              },
              "refund_time": {
                "type": "string",
                "maxLength": 262144,
                "description": "Time when the third-party refund completed, in RFC3339 (e.g., 2018-11-02T12:30:10Z)"
              },
              "transaction_number": {
                "type": "string",
                "maxLength": 262144,
                "description": "Refund transaction number"
              },
              "payment_channel": {
                "type": "string",
                "maxLength": 262144,
                "description": "Refund payment channel"
              },
              "extra_info": {
                "$ref": "#/$defs/v202601.RefundRecordExtraInfo",
                "description": "Extra information attached to the refund record"
              }
            },
            "required": [
              "post_sale_id",
              "refund_record_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Marks the order's in-progress refund records as refunded successfully; afterwards the order is partially refunded or fully refunded.\nThis endpoint applies only to orders paid through a custom payment channel or the test payment channel (bogus). Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.RefundRecordExtraInfo": {
            "type": "object",
            "properties": {
              "pos": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "order_id",
          "type": "string"
        },
        {
          "name": "post_sale_id",
          "type": "string"
        },
        {
          "name": "refund_record",
          "type": "object",
          "schema": "v202601.V202601RefundRecord",
          "has_id": true
        }
      ]
    },
    "order-refund-records": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/refund_records",
      "description": "List refund records",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "Page size (1-100, default 10)"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "order_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "description": "Filter by order IDs. Up to 10 IDs are supported. Example: ?order_ids=1001&order_ids=1002"
              },
              "refund_order_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 20,
                "description": "Filter by refund record IDs. Up to 20 IDs are supported. Example: ?refund_order_ids=2001&refund_order_ids=2002"
              },
              "refund_statuses": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter by refund status. - pending: refund in progress. - finished: refund completed. - failed: refund failed. Example: ?refund_statuses=pending&refund_statuses=finished"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field used to sort the result list: - `created_at`: sort by creation time - `updated_at`: sort by last update time"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sort direction: - `desc`: descending order - `asc`: ascending order"
              },
              "created_at_start": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter records created at or after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "created_at_end": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter records created at or before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "updated_at_start": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter records last updated at or after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "updated_at_end": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter records last updated at or before this time (e.g., 2018-11-02T12:30:10Z)"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Returns refund records across all orders, paginated via cursor and filtered\nby order IDs, refund record IDs, status, sort field/direction, and create/\nupdate time ranges. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "records",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.RefundRecord"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "order-refund-record": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/{order_id}/refund",
      "description": "List order refund records",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Returns all refund records attached to the specified order, along with the\norder's payment and order status at the moment of query. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "order_financial_status",
          "type": "string"
        },
        {
          "name": "order_status",
          "type": "string"
        },
        {
          "name": "records",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.RefundRecord"
          }
        }
      ]
    },
    "order-risk-create": {
      "risk": "H",
      "module": "orders",
      "method": "POST",
      "path": "/orders/{order_id}/risks",
      "description": "Create order risk record",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
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
              "risk": {
                "$ref": "#/$defs/v202506.CreateOrderRiskParam",
                "description": "The order risk object containing risk level and detail information"
              }
            },
            "required": [
              "risk"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Attaches a custom risk record to the specified order with a risk level\n(low/medium/high), supporting detail reasons, and optional custom\nproperties. Typically called after a manual fraud review. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateOrderRiskParam": {
            "type": "object",
            "properties": {
              "level": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "details": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1
              },
              "properties": {
                "type": "object",
                "additionalProperties": {
                  "type": "string",
                  "maxLength": 262144
                }
              }
            },
            "required": [
              "level"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "risk",
          "type": "object",
          "schema": "v202506.OrderRisk",
          "has_id": true
        }
      ]
    },
    "order-risk-delete": {
      "risk": "D",
      "module": "orders",
      "method": "DELETE",
      "path": "/orders/{order_id}/risks/{id}",
      "description": "Delete order risk record",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              },
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order risk record ID"
              }
            },
            "required": [
              "order_id",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Removes a single custom risk record from the order by its id. The order\nitself is not affected; other risk records on the same order remain. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "order-risk-detail": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/{order_id}/risks/{id}",
      "description": "Get order risk record",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              },
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order risk record ID"
              }
            },
            "required": [
              "order_id",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves a single risk record on the order by its id, including risk\nlevel, detail reasons, custom properties, and create/update times. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "risk",
          "type": "object",
          "schema": "v202506.OrderRisk",
          "has_id": true
        }
      ]
    },
    "order-risk-assessments": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/{order_id}/risks",
      "description": "List risk assessments",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              }
            },
            "required": [
              "order_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Returns the platform's automated fraud-detection assessment labels and\ndetail items for the specified order. Use this to surface system-generated\nrisk signals to merchants before they decide to fulfill or cancel the order. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "assessments",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "infos",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.OrderRiskAssessmentInfo"
          }
        }
      ]
    },
    "order-risk-update": {
      "risk": "H",
      "module": "orders",
      "method": "PUT",
      "path": "/orders/{order_id}/risks/{id}",
      "description": "Update order risk record",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              },
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order risk record ID"
              }
            },
            "required": [
              "order_id",
              "id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "risk": {
                "$ref": "#/$defs/v202506.UpdateOrderRiskParam",
                "description": "Order risk update parameters"
              }
            },
            "required": [
              "risk"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Modifies the risk level, detail reasons, or custom properties of an\nexisting risk record on the order. The record is located by its id;\nthe order itself is unchanged. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateOrderRiskParam": {
            "type": "object",
            "properties": {
              "level": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "details": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1
              },
              "properties": {
                "type": "object",
                "additionalProperties": {
                  "type": "string",
                  "maxLength": 262144
                }
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "risk",
          "type": "object",
          "schema": "v202506.OrderRisk",
          "has_id": true
        }
      ]
    },
    "shipping-zone-create": {
      "risk": "H",
      "module": "orders",
      "method": "POST",
      "path": "/shipping-schemas/shipping-zone",
      "description": "Create shopping zone",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "shipping": {
                "$ref": "#/$defs/v202506.CreateShippingParam",
                "description": "Shipping information"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Create a new shipping zone. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateShippingParam": {
            "type": "object",
            "properties": {
              "schema_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "support_cod": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "plans": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.CreateShippingPlanParam"
                },
                "maxItems": 10,
                "minItems": 1
              },
              "areas": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.CreateShippingAreaParam"
                },
                "maxItems": 10,
                "minItems": 1
              }
            },
            "required": [
              "schema_id",
              "name"
            ],
            "additionalProperties": false
          },
          "v202506.CreateShippingPlanParam": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "desc": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_type": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_range_min": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_range_max": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_range_infinite": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "rule_range_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_type": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_amount": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_first_range": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_first_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_additional_amount": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_additional_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_additional_range": {
                "type": "string",
                "maxLength": 262144
              },
              "plan_type": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "plan_type_value": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_type_scope": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              }
            },
            "required": [
              "name"
            ],
            "additionalProperties": false
          },
          "v202506.CreateShippingAreaParam": {
            "type": "object",
            "properties": {
              "country_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "country_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "province_codes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1
              }
            },
            "required": [
              "country_name",
              "country_code"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "shipping",
          "type": "object",
          "schema": "v202506.ShippingSchemasShipping",
          "has_id": true
        }
      ]
    },
    "shipping-zone-delete": {
      "risk": "D",
      "module": "orders",
      "method": "DELETE",
      "path": "/shipping-schemas/shipping-zone/{id}",
      "description": "Delete shopping zone",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "ID of the shipping zone to delete"
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
        "additionalProperties": false,
        "description": "Remove an existing shipping zone. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "available-shipping-lines": {
      "risk": "R",
      "module": "orders",
      "method": "POST",
      "path": "/shipping-lines/available-lines",
      "description": "Get available shipping lines",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
              },
              "country_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Country code"
              },
              "province_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Province/state code. Pass `ALL` to match all provinces (default behavior for most countries). **GB (United Kingdom) special handling:** Because shipping costs vary significantly across England (GB-ENG), Scotland (GB-SCT), Wales (GB-WLS), and Northern Ireland (GB-NIR), an empty value will not match any shipping zone. You must either: - Pass a specific province code (e.g. `GB-ENG`), or - Pass `ALL`, or - Provide `zip` instead — the system will automatically derive the province from the postal code prefix"
              },
              "zip": {
                "type": "string",
                "maxLength": 262144,
                "description": "Zip/postal code. For GB addresses, the system uses the postal code prefix to automatically derive the province code when `province_code` is not provided."
              }
            },
            "required": [
              "order_id",
              "country_code"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Retrieves available shipping options for the specified order and address. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "shipping_lines",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.AvailableShippingLine"
          }
        },
        {
          "name": "invalid_products",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "message",
          "type": "string"
        },
        {
          "name": "state",
          "type": "string"
        }
      ]
    },
    "general-shipping-schema": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/shipping-schemas/general",
      "description": "Get general shopping schema",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve general shopping schemas. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "shipping_schemas",
          "type": "object",
          "schema": "v202506.ShippingSchemas",
          "has_id": true
        }
      ]
    },
    "general-shipping-schema-save": {
      "risk": "H",
      "module": "orders",
      "method": "POST",
      "path": "/shipping-schemas/general",
      "description": "Save general shopping schema",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "shipping_schemas": {
                "$ref": "#/$defs/v202506.SaveShippingSchemasParam",
                "description": "Shipping schemas"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Create or Modify a general shipping schema. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.SaveShippingSchemasParam": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "shippings": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateShippingParam"
                },
                "maxItems": 10
              }
            },
            "required": [
              "name"
            ],
            "additionalProperties": false
          },
          "v202506.UpdateShippingParam": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "support_cod": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "plans": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateShippingPlanParam"
                },
                "maxItems": 10,
                "minItems": 1
              },
              "areas": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateShippingAreaParam"
                },
                "maxItems": 10,
                "minItems": 1
              }
            },
            "required": [
              "name"
            ],
            "additionalProperties": false
          },
          "v202506.UpdateShippingPlanParam": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "desc": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_type": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_range_min": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_range_max": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_range_infinite": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "rule_range_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_type": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_amount": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_first_range": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_first_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_additional_amount": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_additional_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_additional_range": {
                "type": "string",
                "maxLength": 262144
              },
              "plan_type": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "plan_type_value": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_type_scope": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              }
            },
            "required": [
              "name"
            ],
            "additionalProperties": false
          },
          "v202506.UpdateShippingAreaParam": {
            "type": "object",
            "properties": {
              "country_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "country_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "province_codes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1
              }
            },
            "required": [
              "country_name",
              "country_code"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "shipping_schemas",
          "type": "object",
          "schema": "v202506.ShippingSchemas",
          "has_id": true
        }
      ]
    },
    "shipping-zone-update": {
      "risk": "H",
      "module": "orders",
      "method": "PUT",
      "path": "/shipping-schemas/shipping-zone/{id}",
      "description": "Update shopping zone",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "ID of the shipping zone to update"
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
              "shipping": {
                "$ref": "#/$defs/v202506.UpdateShippingParam",
                "description": "Updated shipping zone parameters"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Modify an existing shipping zone. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateShippingParam": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "support_cod": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "plans": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateShippingPlanParam"
                },
                "maxItems": 10,
                "minItems": 1
              },
              "areas": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateShippingAreaParam"
                },
                "maxItems": 10,
                "minItems": 1
              }
            },
            "required": [
              "name"
            ],
            "additionalProperties": false
          },
          "v202506.UpdateShippingPlanParam": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "desc": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_type": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_range_min": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_range_max": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_range_infinite": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "rule_range_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_type": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_amount": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_first_range": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_first_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_additional_amount": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_additional_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "rate_additional_range": {
                "type": "string",
                "maxLength": 262144
              },
              "plan_type": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "plan_type_value": {
                "type": "string",
                "maxLength": 262144
              },
              "rule_type_scope": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              }
            },
            "required": [
              "name"
            ],
            "additionalProperties": false
          },
          "v202506.UpdateShippingAreaParam": {
            "type": "object",
            "properties": {
              "country_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "country_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "province_codes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1
              }
            },
            "required": [
              "country_name",
              "country_code"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "shipping",
          "type": "object",
          "schema": "v202506.ShippingSchemasShipping",
          "has_id": true
        }
      ]
    },
    "tracking-carrier-detect": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/tracking/carriers/detect",
      "description": "Detect carrier by tracking number",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "tracking_number": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Tracking number"
              }
            },
            "required": [
              "tracking_number"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false,
        "description": "Identifies the carrier responsible for handling a shipment based on the provided tracking number. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "tracking_carrier",
          "type": "object",
          "schema": "v202506.TrackingCarrier"
        }
      ]
    },
    "tracking-carriers": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/tracking/carriers",
      "description": "List carriers",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Returns a list of all tracking carriers supported by Shoplazza Fulfillment. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "tracking_carriers",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.TrackingCarrier"
          }
        }
      ]
    },
    "order-transactions-batch": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/transactions",
      "description": "Batch list order transactions",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "order_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 50,
                "minItems": 1,
                "description": "Order IDs to query. Up to 50 per request. Example: ?order_ids=1001&order_ids=1002"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 50,
                "default": 10,
                "description": "Number of transactions per page. Range: 1-50, default: 10."
              },
              "payment_channel": {
                "type": "string",
                "maxLength": 262144,
                "description": "Payment channel (e.g., paypal)."
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "Transaction status. Applies to all orders in the request: - `authorized`: the transaction has been authorized but not yet captured - `void`: the transaction has been canceled - `processing`: the transaction is currently being processed - `success`: the transaction was successfully completed - `failure` / `error`: the transaction failed. Both values exist in the data, so match both when filtering for failed transactions - `refunding`: a refund for the transaction is in progress - `refunded`: the transaction has been successfully refunded - `refund_failed`: the refund attempt for the transaction has failed - `expired`: the transaction has expired"
              }
            },
            "required": [
              "order_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false,
        "description": "Batch retrieve all transactions attached to the specified orders, including\nstatus, payment channel, amount, and gateway response details. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "transactions",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Transaction"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "order-transactions": {
      "risk": "R",
      "module": "orders",
      "method": "GET",
      "path": "/orders/{order_id}/transactions",
      "description": "List order transactions",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
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
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "Transaction status: - `authorized`: the transaction has been authorized but not yet captured - `void`: the transaction has been canceled - `processing`: the transaction is currently being processed - `success`: the transaction was successfully completed - `failure` / `error`: the transaction failed. Both values exist in the data, so match both when filtering for failed transactions - `refunding`: a refund for the transaction is in progress - `refunded`: the transaction has been successfully refunded - `refund_failed`: the refund attempt for the transaction has failed - `expired`: the transaction has expired"
              },
              "payment_channel": {
                "type": "string",
                "maxLength": 262144,
                "description": "Payment channel (e.g., paypal)"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve all transactions attached to the specified order, including\nstatus, payment channel, amount, and gateway response details. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "transactions",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Transaction"
          }
        }
      ]
    },
    "order-update": {
      "risk": "H",
      "module": "orders",
      "method": "PUT",
      "path": "/orders/{order_id}",
      "description": "Update order",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "order_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Order ID"
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
              "order": {
                "$ref": "#/$defs/v202601.UpdateOrderParam",
                "description": "Order"
              }
            },
            "required": [
              "order"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Allows users to update the details of an existing order. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.UpdateOrderParam": {
            "type": "object",
            "properties": {
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "buyer_accepts_marketing": {
                "type": "boolean"
              },
              "shipping_address": {
                "$ref": "#/$defs/v202601.UpdateOrderShippingAddressParam"
              },
              "shipping_line": {
                "$ref": "#/$defs/v202601.UpdateOrderShippingLineParam"
              },
              "additional_prices": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.UpdateAdditionalPrice"
                },
                "maxItems": 10
              },
              "clear_additional_prices": {
                "type": "boolean"
              },
              "order_confirm_notify": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2
              },
              "fulfillment_notify": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2
              },
              "partial_fulfillment_notify": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2
              },
              "order_delivered_notify": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2
              },
              "custom_fields": {
                "type": "object",
                "additionalProperties": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "delete_custom_fields": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.UpdateOrderShippingAddressParam": {
            "type": "object",
            "properties": {
              "last_name": {
                "type": "string",
                "maxLength": 262144
              },
              "first_name": {
                "type": "string",
                "maxLength": 262144
              },
              "phone": {
                "type": "string",
                "maxLength": 262144
              },
              "email": {
                "type": "string",
                "maxLength": 262144
              },
              "country": {
                "type": "string",
                "maxLength": 262144
              },
              "country_code": {
                "type": "string",
                "maxLength": 262144
              },
              "province": {
                "type": "string",
                "maxLength": 262144
              },
              "province_code": {
                "type": "string",
                "maxLength": 262144
              },
              "area": {
                "type": "string",
                "maxLength": 262144
              },
              "city": {
                "type": "string",
                "maxLength": 262144
              },
              "address": {
                "type": "string",
                "maxLength": 262144
              },
              "address1": {
                "type": "string",
                "maxLength": 262144
              },
              "company": {
                "type": "string",
                "maxLength": 262144
              },
              "zip": {
                "type": "string",
                "maxLength": 262144
              },
              "phone_area_code": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.UpdateOrderShippingLineParam": {
            "type": "object",
            "properties": {
              "shipping_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "shipping_desc": {
                "type": "string",
                "maxLength": 262144
              },
              "shipping_price": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "delivery_method": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "extra_info": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "shipping_name",
              "shipping_price"
            ],
            "additionalProperties": false
          },
          "v202601.UpdateAdditionalPrice": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "price": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "biz_id": {
                "type": "string",
                "maxLength": 262144
              },
              "fee_title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "name",
              "price",
              "fee_title"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "order",
          "type": "object",
          "schema": "v202601.Order",
          "has_id": true
        }
      ]
    },
    "product-batch-delete": {
      "risk": "D",
      "module": "products",
      "method": "DELETE",
      "path": "/products",
      "description": "Batch delete products",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "List of product IDs to delete"
              }
            },
            "required": [
              "product_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false,
        "description": "Batch delete products by their IDs. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "categories": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/categories",
      "description": "List categories",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "pid": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Pid of the category"
              },
              "ids": {
                "type": "array",
                "items": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,19})$",
                      "maxLength": 20
                    }
                  ],
                  "x-integer-format": "uint64"
                },
                "maxItems": 100,
                "description": "ID of the categories. Example: ?ids=1001&ids=1002"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "List all categories in the shop Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "categories",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.CategoryParam"
          }
        }
      ]
    },
    "collection-async-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/collections/async",
      "description": "Asynchronously create a smart collection",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "collection": {
                "$ref": "#/$defs/v202601.CreateCollectionParam",
                "description": "Collection"
              }
            },
            "required": [
              "collection"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Initiates an asynchronous creation of a smart collection. Only smart collections are supported by this endpoint.\nReturns an async task ID immediately; use GetCollectionAsyncTask to poll the result. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.CreateCollectionParam": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "handle": {
                "type": "string",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "maxLength": 262144
              },
              "image": {
                "$ref": "#/$defs/v202601.CollectionImageParam"
              },
              "seo_title": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "seo_description": {
                "type": "string",
                "maxLength": 262144
              },
              "sort_order": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "default": "manual"
              },
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "smart": {
                "type": "boolean"
              },
              "match_rules": {
                "$ref": "#/$defs/v202601.MatchRuleParam"
              },
              "tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [
              "title"
            ],
            "additionalProperties": false
          },
          "v202601.CollectionImageParam": {
            "type": "object",
            "properties": {
              "src": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "width": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "height": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "alt": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "src"
            ],
            "additionalProperties": false
          },
          "v202601.MatchRuleParam": {
            "type": "object",
            "properties": {
              "disjunctive": {
                "type": "boolean"
              },
              "rule_modules": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.RuleModuleParam"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.RuleModuleParam": {
            "type": "object",
            "properties": {
              "disjunctive": {
                "type": "boolean"
              },
              "rules": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.RuleParam"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.RuleParam": {
            "type": "object",
            "properties": {
              "column": {
                "type": "string",
                "maxLength": 262144
              },
              "relation": {
                "type": "string",
                "maxLength": 262144
              },
              "condition": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "async_task_id",
          "type": "string"
        },
        {
          "name": "error_message",
          "type": "string"
        },
        {
          "name": "collection",
          "type": "object",
          "schema": "v202601.Collection",
          "has_id": true
        }
      ]
    },
    "smart-collection-rule-async-update": {
      "risk": "H",
      "module": "products",
      "method": "PATCH",
      "path": "/collections/{id}/smart-rule/async",
      "description": "Asynchronously update smart collection rules",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Collection ID"
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
              "match_rules": {
                "$ref": "#/$defs/v202601.MatchRuleParam",
                "description": "Smart collection match rules"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Initiates an asynchronous update of a smart collection's match rules. Returns an async task ID immediately;\nuse GetCollectionAsyncTask to poll the result. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.MatchRuleParam": {
            "type": "object",
            "properties": {
              "disjunctive": {
                "type": "boolean"
              },
              "rule_modules": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.RuleModuleParam"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.RuleModuleParam": {
            "type": "object",
            "properties": {
              "disjunctive": {
                "type": "boolean"
              },
              "rules": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.RuleParam"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.RuleParam": {
            "type": "object",
            "properties": {
              "column": {
                "type": "string",
                "maxLength": 262144
              },
              "relation": {
                "type": "string",
                "maxLength": 262144
              },
              "condition": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "async_task_id",
          "type": "string"
        },
        {
          "name": "collection",
          "type": "object",
          "schema": "v202601.Collection",
          "has_id": true
        }
      ]
    },
    "collection-count": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/collections/count",
      "description": "Get collection count",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "ISO 8601 timestamp. Only include collections updated after this time"
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "ISO 8601 timestamp. Only include collections updated before this time"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve the total number of collections that match specific criteria. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "Count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "collection-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/collections",
      "description": "Create collection",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "collection": {
                "$ref": "#/$defs/v202601.CreateCollectionParam",
                "description": "Collection"
              }
            },
            "required": [
              "collection"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Allows users to create a new collection in the store, including details like the title, description, associated products, SEO attributes, and merchandise sorting rules. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.CreateCollectionParam": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "handle": {
                "type": "string",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "maxLength": 262144
              },
              "image": {
                "$ref": "#/$defs/v202601.CollectionImageParam"
              },
              "seo_title": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "seo_description": {
                "type": "string",
                "maxLength": 262144
              },
              "sort_order": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "default": "manual"
              },
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "smart": {
                "type": "boolean"
              },
              "match_rules": {
                "$ref": "#/$defs/v202601.MatchRuleParam"
              },
              "tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [
              "title"
            ],
            "additionalProperties": false
          },
          "v202601.CollectionImageParam": {
            "type": "object",
            "properties": {
              "src": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "width": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "height": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "alt": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "src"
            ],
            "additionalProperties": false
          },
          "v202601.MatchRuleParam": {
            "type": "object",
            "properties": {
              "disjunctive": {
                "type": "boolean"
              },
              "rule_modules": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.RuleModuleParam"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.RuleModuleParam": {
            "type": "object",
            "properties": {
              "disjunctive": {
                "type": "boolean"
              },
              "rules": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.RuleParam"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.RuleParam": {
            "type": "object",
            "properties": {
              "column": {
                "type": "string",
                "maxLength": 262144
              },
              "relation": {
                "type": "string",
                "maxLength": 262144
              },
              "condition": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "collection",
          "type": "object",
          "schema": "v202601.Collection",
          "has_id": true
        }
      ]
    },
    "collection-delete": {
      "risk": "D",
      "module": "products",
      "method": "DELETE",
      "path": "/collections/{id}",
      "description": "Delete collection",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Collection ID. Must be a valid UUID"
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
        "additionalProperties": false,
        "description": "Allows users to delete a specific collection by providing its unique ID in the path parameter. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "collection-detail": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/collections/{id}",
      "description": "Get collection",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Collection ID. Must be a valid UUID"
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
        "additionalProperties": false,
        "description": "Retrieves detailed information about a specific collection by providing its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "collection",
          "type": "object",
          "schema": "v202601.Collection",
          "has_id": true
        }
      ]
    },
    "collection-async-task-detail": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/collections/async-task/{id}",
      "description": "Get collection async task",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Async task ID returned by AsyncCreateCollection or AsyncUpdateSmartCollectionRule"
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
              "source_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Source resource ID this task operates on (e.g. collection UUID). Used as an alternative lookup key together with task_type when async task ID is unknown"
              },
              "task_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Task type. Allowed values: - `create_collection`: async smart collection creation - `update_smart_collection_rule`: async smart collection rule update"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves the status and result of an asynchronous collection task initiated by AsyncCreateCollection or AsyncUpdateSmartCollectionRule. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "async_task",
          "type": "object",
          "schema": "v202601.AsyncTask",
          "has_id": true
        }
      ]
    },
    "collections": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/collections",
      "description": "List collections",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "A limit on the number of objects to return. Range: 1-100 (default is 10)"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "List of collection IDs to retrieve specific collections. Example: ?ids=1001&ids=1002"
              },
              "title": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter collections by their title (supports partial matching)"
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Minimum timestamp for filtering collections by their last updated date. Format: YYYY-MM-DDTHH:mm:ssZ"
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Maximum timestamp for filtering collections by their last updated date. Format: YYYY-MM-DDTHH:mm:ssZ"
              },
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "UUID of a product to filter collections that include the product"
              },
              "smart": {
                "type": "boolean",
                "description": "Filter whether smart collection"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieves a list of collections based on various filter criteria, such as product_id, title, or update timestamps. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "collections",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.Collection"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "collection-update": {
      "risk": "H",
      "module": "products",
      "method": "PUT",
      "path": "/collections/{id}",
      "description": "Update collection",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Collection ID. Must be a valid UUID"
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
              "collection": {
                "$ref": "#/$defs/v202601.UpdateCollectionParam",
                "description": "Collection"
              }
            },
            "required": [
              "collection"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Allows users to update details of an existing collection by providing the collection ID and the desired updates in the request body. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.UpdateCollectionParam": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "handle": {
                "type": "string",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "maxLength": 262144
              },
              "image": {
                "$ref": "#/$defs/v202601.CollectionImageParam"
              },
              "seo_title": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "seo_description": {
                "type": "string",
                "maxLength": 262144
              },
              "sort_order": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "default": "manual"
              },
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "add_product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "delete_product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.CollectionImageParam": {
            "type": "object",
            "properties": {
              "src": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "width": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "height": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "alt": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "src"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "collection",
          "type": "object",
          "schema": "v202601.Collection",
          "has_id": true
        }
      ]
    },
    "smart-collection-rule-update": {
      "risk": "H",
      "module": "products",
      "method": "PATCH",
      "path": "/collections/{id}/smart-rule",
      "description": "Update smart collection rules",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Collection ID"
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
              "match_rules": {
                "$ref": "#/$defs/v202601.MatchRuleParam",
                "description": "Smart collection match rules"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Allows users to update smart collection rules by providing the collection ID and the desired updates in the request body. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.MatchRuleParam": {
            "type": "object",
            "properties": {
              "disjunctive": {
                "type": "boolean"
              },
              "rule_modules": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.RuleModuleParam"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.RuleModuleParam": {
            "type": "object",
            "properties": {
              "disjunctive": {
                "type": "boolean"
              },
              "rules": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.RuleParam"
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.RuleParam": {
            "type": "object",
            "properties": {
              "column": {
                "type": "string",
                "maxLength": 262144
              },
              "relation": {
                "type": "string",
                "maxLength": 262144
              },
              "condition": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "collection",
          "type": "object",
          "schema": "v202601.Collection",
          "has_id": true
        }
      ]
    },
    "collect-batch-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/collects/batch",
      "description": "Batch create collect",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "collection_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Collection ID"
              },
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "Product ID"
              }
            },
            "required": [
              "collection_id",
              "product_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Creates multiple product-collection associations in a single request. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "collect-count": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/collects/count",
      "description": "Get collect count",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "collection_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Collection ID"
              },
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product ID"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieves the total number of collect objects that associate products with a collection. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "collect-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/collects",
      "description": "Create collect",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "collect": {
                "$ref": "#/$defs/v202506.CreateCollectParam",
                "description": "Collect (product-collection relation)"
              }
            },
            "required": [
              "collect"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Associates a product with a collection by creating a collect object. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateCollectParam": {
            "type": "object",
            "properties": {
              "collection_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "product_id": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "collection_id",
              "product_id"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "collect",
          "type": "object",
          "schema": "v202506.Collect",
          "has_id": true
        }
      ]
    },
    "collect-delete": {
      "risk": "D",
      "module": "products",
      "method": "DELETE",
      "path": "/collects/{id}",
      "description": "Delete collect",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier of the collect. Must be a valid UUID"
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
        "additionalProperties": false,
        "description": "Removes an association between a product and a collection by deleting a collect object. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "collect-detail": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/collects/{id}",
      "description": "Get collect",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier of the collect. Must be a valid UUID"
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
        "additionalProperties": false,
        "description": "Retrieves detailed information about a specific collect by its unique identifier (id) Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "collect",
          "type": "object",
          "schema": "v202506.Collect",
          "has_id": true
        }
      ]
    },
    "collects": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/collects",
      "description": "List collects",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "A limit on the number of objects to return. Range: 1-100 (default is 10)"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "UUID of the collection to filter collects"
              },
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "UUID of the product to filter collects"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieves a list of collect objects, representing the associations between products and collections. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "collects",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Collect"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "comment-batch-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/comments/batch",
      "description": "Batch create comment",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "comments": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.CreateCommentParam"
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "List of comments"
              }
            },
            "required": [
              "comments"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Allows users to create multiple comments for products in a single request. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateCommentParam": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144
              },
              "user_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "star": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5
              },
              "like": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483647
              },
              "created_at": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "content": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "country": {
                "type": "string",
                "maxLength": 262144
              },
              "images": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [
              "product_id",
              "user_name",
              "star",
              "like",
              "created_at",
              "content"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "success_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "error_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "error_infos",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.BatchCreateCommentError"
          }
        }
      ]
    },
    "comment-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/comments",
      "description": "Create comment",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "comment": {
                "$ref": "#/$defs/v202506.CreateCommentParam",
                "description": "Comment"
              }
            },
            "required": [
              "comment"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Allows users to add a comment to a specific product. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateCommentParam": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144
              },
              "user_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "star": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5
              },
              "like": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483647
              },
              "created_at": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "content": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "country": {
                "type": "string",
                "maxLength": 262144
              },
              "images": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [
              "product_id",
              "user_name",
              "star",
              "like",
              "created_at",
              "content"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "comment",
          "type": "object",
          "schema": "v202506.Comment",
          "has_id": true
        }
      ]
    },
    "comments": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/comments/list",
      "description": "List comments",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Limit per page"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product's ID to filter comments"
              },
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filters comments created at or after this date. Format: YYYY-MM-DDTHH:mm:ssZ"
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filters comments created at or before this date. Format: YYYY-MM-DDTHH:mm:ssZ"
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filters comments updated at or after this date. Format: YYYY-MM-DDTHH:mm:ssZ"
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filters comments updated at or before this date. Format: YYYY-MM-DDTHH:mm:ssZ"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Specify the sort field. e.g.star or created_at"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Specify the sort direction. asc or desc"
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "Comment status. 1 for published, 0 for unpublished"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve a list of comments for a specific product or across multiple products, based on various filters. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "comments",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Comment"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "product-count": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/products/count",
      "description": "Count products",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Product's IDs. Example: ?ids=2001&ids=2002"
              },
              "title": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product's title"
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Collection UUID, for example: `9e79ca1f-9ff2-409b-976f-98be343d38a3`"
              },
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products created at or after date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products created at or before date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products last updated at or after date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products last updated at or before date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "published_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products published at or after date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "published_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products published at or before date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "published_status": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by published status: `published`, `unpublished`, `any`"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Count the number of products based on the provided filters. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int64"
        }
      ]
    },
    "product-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/products",
      "description": "Create product",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "product": {
                "$ref": "#/$defs/v202506.Product",
                "description": "Product data to be created"
              }
            },
            "required": [
              "product"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a new product with the provided details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.Product": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "brief": {
                "type": "string",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "maxLength": 262144
              },
              "published": {
                "type": "boolean"
              },
              "requires_shipping": {
                "type": "boolean"
              },
              "taxable": {
                "type": "boolean"
              },
              "tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "vendor": {
                "type": "string",
                "maxLength": 262144
              },
              "vendor_url": {
                "type": "string",
                "maxLength": 262144
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_title": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_description": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "handle": {
                "type": "string",
                "maxLength": 262144
              },
              "has_only_default_variant": {
                "type": "boolean"
              },
              "inventory_tracking": {
                "type": "boolean"
              },
              "inventory_policy": {
                "type": "string",
                "maxLength": 262144
              },
              "need_variant_image": {
                "type": "boolean"
              },
              "spu": {
                "type": "string",
                "maxLength": 262144
              },
              "fake_sales": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "display_fake_sales": {
                "type": "boolean"
              },
              "options": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.Option"
                },
                "maxItems": 10
              },
              "images": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.CreateProductImage"
                },
                "maxItems": 10,
                "minItems": 1
              },
              "variants": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.CreateProductVariantParam"
                },
                "maxItems": 10,
                "minItems": 1
              },
              "mixed_wholesale": {
                "type": "boolean"
              },
              "collection_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "product_type": {
                "type": "string",
                "maxLength": 262144
              },
              "brand": {
                "type": "string",
                "maxLength": 262144
              },
              "unique_token": {
                "type": "string",
                "maxLength": 262144
              },
              "independent_seo": {
                "type": "boolean"
              },
              "inventory_quantity": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "category_id": {
                "type": "string",
                "maxLength": 262144
              },
              "auto_publish_at": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "title",
              "has_only_default_variant",
              "images",
              "variants"
            ],
            "additionalProperties": false
          },
          "v202506.Option": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "values": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1
              }
            },
            "required": [
              "name",
              "values"
            ],
            "additionalProperties": false
          },
          "v202506.CreateProductImage": {
            "type": "object",
            "properties": {
              "src": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "width": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "height": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "alt": {
                "type": "string",
                "maxLength": 262144
              },
              "path": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "src"
            ],
            "additionalProperties": false
          },
          "v202506.CreateProductVariantParam": {
            "type": "object",
            "properties": {
              "option1": {
                "type": "string",
                "maxLength": 262144
              },
              "option2": {
                "type": "string",
                "maxLength": 262144
              },
              "option3": {
                "type": "string",
                "maxLength": 262144
              },
              "image": {
                "$ref": "#/$defs/v202506.CreateProductImage"
              },
              "compare_at_price": {
                "type": "number"
              },
              "price": {
                "type": "number",
                "minimum": 0
              },
              "sku": {
                "type": "string",
                "maxLength": 262144
              },
              "barcode": {
                "type": "string",
                "maxLength": 262144
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "inventory_quantity": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "weight": {
                "type": "number"
              },
              "weight_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "cost_price": {
                "type": "number"
              },
              "wholesale_price": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.WholePrice"
                },
                "maxItems": 10
              },
              "whole_prices": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.WholePrice"
                },
                "maxItems": 10
              },
              "retail_price": {
                "type": "number"
              },
              "position": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "extend": {
                "$ref": "#/$defs/v202506.VariantExtend"
              }
            },
            "required": [
              "price"
            ],
            "additionalProperties": false
          },
          "v202506.WholePrice": {
            "type": "object",
            "properties": {
              "price": {
                "type": "number",
                "minimum": 0
              },
              "min_quantity": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "x-integer-minimum": "0"
              }
            },
            "required": [
              "price",
              "min_quantity"
            ],
            "additionalProperties": false
          },
          "v202506.VariantExtend": {
            "type": "object",
            "properties": {
              "length": {
                "type": "number"
              },
              "width": {
                "type": "number"
              },
              "height": {
                "type": "number"
              },
              "dimension_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "origin_country_code": {
                "type": "string",
                "maxLength": 262144
              },
              "hs_code": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "product",
          "type": "object",
          "schema": "v202506.ProductRes",
          "has_id": true
        }
      ]
    },
    "product-delete": {
      "risk": "D",
      "module": "products",
      "method": "DELETE",
      "path": "/products/{product_id}",
      "description": "Delete product",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Specifies which product is to be deleted"
              }
            },
            "required": [
              "product_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Delete a product by its ID. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "product-detail": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/products/{product_id}",
      "description": "Get product",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Specifies which product is to be retrieved"
              }
            },
            "required": [
              "product_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve a single product by its ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "product",
          "type": "object",
          "schema": "v202506.ProductRes",
          "has_id": true
        }
      ]
    },
    "gift-card-batch-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/gift_cards/batch",
      "description": "Batch create gift cards",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "gift_cards": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.BatchCreateGiftCardParam"
                },
                "maxItems": 10,
                "description": "Gift card information"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Creates gift cards for a specific customer or store. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.BatchCreateGiftCardParam": {
            "type": "object",
            "properties": {
              "code": {
                "type": "string",
                "maxLength": 20,
                "minLength": 8
              },
              "initial_value": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "expires_on": {
                "type": "string",
                "maxLength": 262144
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "customer_id": {
                "type": "string",
                "maxLength": 262144
              },
              "template_suffix": {
                "type": "string",
                "maxLength": 262144
              },
              "send_email": {
                "type": "boolean"
              },
              "currency": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "balance": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "code",
              "initial_value",
              "currency"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "success_gift_cards",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.BatchCreateGiftCard"
          }
        },
        {
          "name": "failed_gift_cards",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.BatchCreateGiftCard"
          }
        }
      ]
    },
    "gift-card-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/gift_cards",
      "description": "Create gift card",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "gift_card": {
                "$ref": "#/$defs/v202506.CreateGiftCardParam",
                "description": "Gift card information"
              }
            },
            "required": [
              "gift_card"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Creates a new gift card for a specific customer or store. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateGiftCardParam": {
            "type": "object",
            "properties": {
              "code": {
                "type": "string",
                "maxLength": 20,
                "minLength": 8
              },
              "initial_value": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "expires_on": {
                "type": "string",
                "maxLength": 262144
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "customer_id": {
                "type": "string",
                "maxLength": 262144
              },
              "template_suffix": {
                "type": "string",
                "maxLength": 262144
              },
              "send_email": {
                "type": "boolean"
              },
              "currency": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "code",
              "initial_value"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "gift_card",
          "type": "object",
          "schema": "v202506.GiftCard",
          "has_id": true
        }
      ]
    },
    "gift-card-disable": {
      "risk": "D",
      "module": "products",
      "method": "POST",
      "path": "/gift_cards/{id}/disable",
      "description": "Disable gift card",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Gift card's unique ID"
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
        "additionalProperties": false,
        "description": "Disables a specific gift card using its unique ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "gift_card",
          "type": "object",
          "schema": "v202506.GiftCard",
          "has_id": true
        }
      ]
    },
    "gift-card-detail": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/gift_cards/{id}",
      "description": "Get gift card",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Gift card's unique ID"
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
        "additionalProperties": false,
        "description": "Retrieves details of a specific gift card by its ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "gift_card",
          "type": "object",
          "schema": "v202506.GiftCard",
          "has_id": true
        }
      ]
    },
    "gift-cards": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/gift_cards",
      "description": "List gift cards",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "Number of records per page. The default value is 10"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "List of gift card IDs to filter by. Example: ?ids=GC1001&ids=GC1002"
              },
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter gift cards created at or after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter gift cards created at or before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter gift cards last updated at or after this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter gift cards last updated at or before this time (e.g., 2018-11-02T12:30:10Z)"
              },
              "initial_value_min": {
                "type": "number",
                "description": "Filter gift cards with initial value greater than or equal to this amount"
              },
              "initial_value_max": {
                "type": "number",
                "description": "Filter gift cards with initial value less than or equal to this amount"
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "Status of the gift card: - `enable`: gift card is active and usable - `disable`: gift card is disabled and cannot be used"
              },
              "balance_status": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by balance status of the gift card"
              },
              "keyword": {
                "type": "string",
                "maxLength": 262144,
                "description": "Keyword for searching gift cards (e.g., matches against code or note)"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field to sort the results by (e.g., created_at, updated_at)"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sort direction: - `asc`: ascending order - `desc`: descending order"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieves a list of gift cards with various filtering options. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "gift_cards",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.GiftCard"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "gift-card-update": {
      "risk": "H",
      "module": "products",
      "method": "PUT",
      "path": "/gift_cards/{id}",
      "description": "Update gift card",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Gift card's unique ID"
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
              "gift_card": {
                "$ref": "#/$defs/v202506.UpdateGiftCardParam",
                "description": "Gift card"
              }
            },
            "required": [
              "gift_card"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Updates the details of a specific gift card using its unique ID. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateGiftCardParam": {
            "type": "object",
            "properties": {
              "expires_on": {
                "type": "string",
                "maxLength": 262144
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "template_suffix": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "gift_card",
          "type": "object",
          "schema": "v202506.GiftCard",
          "has_id": true
        }
      ]
    },
    "product-image-count": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/products/{product_id}/images/count",
      "description": "Get product image count",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier for the product"
              }
            },
            "required": [
              "product_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve the total number of product image. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "product-image-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/products/{product_id}/images",
      "description": "Create product image",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier for the product"
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
              "image": {
                "$ref": "#/$defs/v202506.CreateProductImageParam",
                "description": "Image"
              }
            },
            "required": [
              "image"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a new product image with the provided details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateProductImageParam": {
            "type": "object",
            "properties": {
              "src": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "alt": {
                "type": "string",
                "maxLength": 262144
              },
              "width": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "height": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "position": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              }
            },
            "required": [
              "src"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "image",
          "type": "object",
          "schema": "v202506.ProductImage",
          "has_id": true
        }
      ]
    },
    "product-image-delete": {
      "risk": "D",
      "module": "products",
      "method": "DELETE",
      "path": "/products/{product_id}/images/{image_id}",
      "description": "Delete product image",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier for the product"
              },
              "image_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier of the image"
              }
            },
            "required": [
              "product_id",
              "image_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Delete a specific product image using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "product-image-detail": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/products/{product_id}/images/{image_id}",
      "description": "Get product image",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier for the product"
              },
              "image_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier of the image"
              }
            },
            "required": [
              "product_id",
              "image_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve details of a specific product image using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "image",
          "type": "object",
          "schema": "v202506.ProductImage",
          "has_id": true
        }
      ]
    },
    "product-images": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/products/{product_id}/images",
      "description": "List product images",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier for the product"
              }
            },
            "required": [
              "product_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve a list of all product image with pagination. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "images",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ProductImage"
          }
        }
      ]
    },
    "product-image-update": {
      "risk": "H",
      "module": "products",
      "method": "PUT",
      "path": "/products/{product_id}/images/{image_id}",
      "description": "Update product image",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier for the product"
              },
              "image_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier of the image"
              }
            },
            "required": [
              "product_id",
              "image_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "image": {
                "$ref": "#/$defs/v202506.UpdateProductImageParam",
                "description": "Image"
              }
            },
            "required": [
              "image"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update the details of an existing product image using its unique identifier. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateProductImageParam": {
            "type": "object",
            "properties": {
              "src": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "position": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "image",
          "type": "object",
          "schema": "v202506.ProductImage",
          "has_id": true
        }
      ]
    },
    "inventory-level-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/inventory_levels",
      "description": "Create inventory",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "inventory_item_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Inventory item ID"
              },
              "location_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Location ID"
              }
            },
            "required": [
              "inventory_item_id",
              "location_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Sets the inventory level for a specific location and inventory item. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "inventory_level",
          "type": "object",
          "schema": "v202506.InventoryLevel"
        }
      ]
    },
    "inventory-level-delete": {
      "risk": "D",
      "module": "products",
      "method": "DELETE",
      "path": "/inventory_levels",
      "description": "Delete inventory",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "inventory_item_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Inventory item ID"
              },
              "location_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Location ID"
              }
            },
            "required": [
              "inventory_item_id",
              "location_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Deletes an inventory level for a specific location and inventory item. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "product-inventory": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/products/{product_id}/inventory",
      "description": "Get product inventory",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product ID"
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
              "location_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Location to filter inventory details (optional) ID"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves the inventory details of a product by its unique identifier (product_id). Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "Stock",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "variants",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.VariantInventory"
          }
        }
      ]
    },
    "inventory-item": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/inventory_items/{inventory_item_id}",
      "description": "Get inventory item",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "inventory_item_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Inventory item ID"
              }
            },
            "required": [
              "inventory_item_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves details of a specific inventory item by its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "inventory_item",
          "type": "object",
          "schema": "v202506.InventoryItem",
          "has_id": true
        }
      ]
    },
    "inventory-item-variants": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/inventory_items/variant",
      "description": "List variant inventory items",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "variant_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "minItems": 1,
                "description": "List of variant ids, must contain at least one ID. Example: ?variant_ids=2001&variant_ids=2002"
              }
            },
            "required": [
              "variant_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false,
        "description": "Returns a list of inventory items associated with product variants. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "variant_inventory_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.VariantInventoryItem"
          }
        }
      ]
    },
    "inventory-items": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/inventory_items",
      "description": "List inventory items",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "inventory_item_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "minItems": 1,
                "description": "List of inventory ids, must contain at least one ID. Example: ?inventory_item_ids=1001&inventory_item_ids=1002"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "A limit on the number of objects to return"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              }
            },
            "required": [
              "inventory_item_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false,
        "description": "Returns a paginated list of inventory items. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "inventory_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.InventoryItem"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "inventory-levels": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/inventory_levels",
      "description": "List inventory",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "inventory_item_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "List of inventory item IDs. Example: ?inventory_item_ids=1003&inventory_item_ids=1004"
              },
              "location_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Location to filter inventory details (optional) ID. Example: ?location_ids=3001&location_ids=3002"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "A limit on the number of objects to return"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Minimum update time (ISO 8601 format, e.g., 2018-10-01T16:15:47-04:00)"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Returns a paginated list of inventory levels. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "inventory_levels",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.InventoryLevel"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "inventory-level-set": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/inventory_levels/set",
      "description": "Set inventory quantity",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "inventory_item_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Inventory item ID"
              },
              "location_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Location ID"
              },
              "stock": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Stock quantity"
              }
            },
            "required": [
              "inventory_item_id",
              "location_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Sets the inventory level for a specific location and inventory item. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "inventory_level",
          "type": "object",
          "schema": "v202506.InventoryLevel"
        }
      ]
    },
    "inventory-item-update": {
      "risk": "H",
      "module": "products",
      "method": "PUT",
      "path": "/inventory_items/{inventory_item_id}",
      "description": "Update inventory item",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "inventory_item_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Inventory item ID"
              }
            },
            "required": [
              "inventory_item_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "inventory_item": {
                "$ref": "#/$defs/v202506.UpdateInventoryItemParam",
                "description": "Inventory item"
              }
            },
            "required": [
              "inventory_item"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Updates the details of an existing inventory item. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateInventoryItemParam": {
            "type": "object",
            "properties": {
              "tracking": {
                "type": "boolean"
              },
              "tracking_policy": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "inventory_item",
          "type": "object",
          "schema": "v202506.InventoryItem",
          "has_id": true
        }
      ]
    },
    "inventory-level-update": {
      "risk": "H",
      "module": "products",
      "method": "PUT",
      "path": "/inventory_levels",
      "description": "Update inventory",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "inventory_item_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Inventory item ID"
              },
              "location_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Location ID"
              },
              "stock_adjustment": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Stock adjustment"
              }
            },
            "required": [
              "inventory_item_id",
              "location_id",
              "stock_adjustment"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Updates the inventory level for a specific location and inventory item. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "inventory_level",
          "type": "object",
          "schema": "v202506.InventoryLevel"
        }
      ]
    },
    "products": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/products",
      "description": "List products",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Product's IDs. Example: ?ids=1001&ids=1002"
              },
              "title": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product's title"
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Collection UUID, for example: `9e79ca1f-9ff2-409b-976f-98be343d38a3`"
              },
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products created at or after date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products created at or before date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products last updated at or after date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products last updated at or before date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "published_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products published at or after date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "published_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products published at or before date, for example: `2018-10-01T16:15:47-04:00`"
              },
              "published_status": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by published status: `published`, `unpublished`, `any`"
              },
              "spus": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Product's SPUs, separated by comma, for example: `spu1,spu2`"
              },
              "pre_cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Previous page cursor for cursor-based pagination"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Page cursor for cursor-based pagination"
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Limit per page, maximum 250"
              },
              "fields": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter fields return in responses. Example: ?fields=id&fields=title"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sort by direction, possible values are: `desc`, `asc`"
              },
              "exclude_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Exclude_ids is used to exclude products by their IDs, for example: `product_id1,product_id2`"
              },
              "product_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by product type, available values are: `all`, `default`, `gift_card`, empty means all products"
              },
              "product_behaviour": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product behaviour, available values are: `hidden`, empty means all products"
              },
              "location_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Filter by the location ID of the stock"
              },
              "vendors": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter by the vendor of the product. Example: ?vendors=Nike&vendors=Adidas"
              },
              "vendors_match": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Fuzzy matching filter by the vendor of the product. Example: ?vendors_match=Nik&vendors_match=Adid"
              },
              "handles": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Filter products by the handles. Example: ?handles=t-shirt&handles=hoodie"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve a list of products with pagination. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "pre_cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "products",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ProductRes"
          }
        }
      ]
    },
    "location-count": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/locations/count",
      "description": "Count locations",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Count all locations for shipping, inventory, and order fulfillment. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int64"
        }
      ]
    },
    "location-deactivate": {
      "risk": "D",
      "module": "products",
      "method": "POST",
      "path": "/locations/deactivate",
      "description": "Deactivate location",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "location_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Location ID"
              },
              "target_location_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Target location ID"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Deactivate location Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "location-edit-priority": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/locations/priority",
      "description": "Edit location priority",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "location_ids": {
                "type": "array",
                "items": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,19})$",
                      "maxLength": 20
                    }
                  ],
                  "x-integer-format": "uint64"
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "List of location IDs"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "edit location priority Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "location-detail": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/locations/{location_id}",
      "description": "Get location",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "location_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Location ID"
              }
            },
            "required": [
              "location_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Get location for shipping, inventory, and order fulfillment by id Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "location",
          "type": "object",
          "schema": "v202506.Location",
          "has_id": true
        }
      ]
    },
    "location-get-default": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/locations/default",
      "description": "Get default location",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Get default location. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "location",
          "type": "object",
          "schema": "v202506.Location",
          "has_id": true
        }
      ]
    },
    "location-inventory-levels": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/locations/{location_id}/inventory_levels",
      "description": "List inventory levels",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "location_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Location ID"
              }
            },
            "required": [
              "location_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Number of records per page"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "List all inventory information of this location. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "inventory_levels",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.InventoryLevel"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "locations": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/locations",
      "description": "List locations",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor of the next page"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Number of records per page"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "enum": [
                  "Unknown",
                  "Activate",
                  "Deactivate"
                ],
                "description": "Default to 0; 0: All, 1: Search the warehouse that is enabled, 2: Search the warehouse that is not enabled"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sort field. Defaults to listing the default location first. Supports \"priority\""
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "List all locations for shipping, inventory, and order fulfillment. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "locations",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Location"
          }
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "location-change-default": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/locations/default",
      "description": "Change default location",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "location_id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Location ID"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "change default location Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "procurement-item-batch-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/procurements/{procurement_id}/items",
      "description": "Batch create procurement items",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "procurement_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The unique identifier of the procurement record"
              }
            },
            "required": [
              "procurement_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "items": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.CreateProcurementItemParam"
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "The array of items to be added to the procurement record"
              }
            },
            "required": [
              "items"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Allows the bulk addition of procurement items to a procurement record. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateProcurementItemParam": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144
              },
              "variant_id": {
                "type": "string",
                "maxLength": 262144
              },
              "transfer_quantity": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483647
              }
            },
            "required": [
              "product_id",
              "variant_id",
              "transfer_quantity"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "fail_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.CreateProcurementItemData"
          }
        }
      ]
    },
    "procurement-item-batch-delete": {
      "risk": "D",
      "module": "products",
      "method": "DELETE",
      "path": "/procurements/{procurement_id}/items",
      "description": "Batch delete procurement items",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "procurement_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The unique identifier of the procurement record"
              }
            },
            "required": [
              "procurement_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "procurement_item_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "An array of IDs of procurement items to delete"
              }
            },
            "required": [
              "procurement_item_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Removes multiple items from a specific procurement order. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "procurement-item-batch-update": {
      "risk": "H",
      "module": "products",
      "method": "PUT",
      "path": "/procurements/{procurement_id}/items",
      "description": "Batch update procurement items",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "procurement_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The unique identifier of the procurement record"
              }
            },
            "required": [
              "procurement_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "items": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateProcurementItemParam"
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "The array of items to be added to the procurement record"
              }
            },
            "required": [
              "items"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "allows bulk updating of procurement item quantities in a specified procurement. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateProcurementItemParam": {
            "type": "object",
            "properties": {
              "procurement_item_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "transfer_quantity": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483647
              }
            },
            "required": [
              "procurement_item_id",
              "transfer_quantity"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": []
    },
    "procurement-cancel": {
      "risk": "D",
      "module": "products",
      "method": "PATCH",
      "path": "/procurements/{procurement_id}/cancel",
      "description": "Cancel procurement",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "procurement_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The unique identifier of the procurement record to cancel"
              }
            },
            "required": [
              "procurement_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Allows canceling an existing procurement record by its unique identifier (id). Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "Procurement",
          "type": "object",
          "schema": "v202506.Procurement",
          "has_id": true
        }
      ]
    },
    "procurement-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/procurements",
      "description": "Create procurement",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "procurement": {
                "$ref": "#/$defs/v202506.CreateProcurementParam",
                "description": "Procurement"
              }
            },
            "required": [
              "procurement"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Allows users to create a procurement record associated with a specific supplier. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateProcurementParam": {
            "type": "object",
            "properties": {
              "supplier_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "supplier_id"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "Procurement",
          "type": "object",
          "schema": "v202506.Procurement",
          "has_id": true
        }
      ]
    },
    "procurement-detail": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/procurements/{procurement_id}",
      "description": "Get procurement",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "procurement_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Provide procurement ID to filter by"
              }
            },
            "required": [
              "procurement_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves a list of procurement records with optional filters such as state, creation date, or update date. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "procurement",
          "type": "object",
          "schema": "v202506.Procurement",
          "has_id": true
        }
      ]
    },
    "procurements": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/procurements",
      "description": "List procurements",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "A limit on the number of objects to return. Range: 1-100 (default is 10)"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Array of procurement IDs to filter by. Example: ?ids=1001&ids=1002"
              },
              "state": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Procurement state filter. Accepted values: 1 (waiting for stock), 2 (partial receipt), 3 (complete receipt), 4 (cancelled)"
              },
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter procurements created at or after this date (ISO-8601 format)"
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter procurements created at or before this date (ISO-8601 format)"
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter procurements updated at or after this date (ISO-8601 format)"
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter procurements updated at or before this date (ISO-8601 format)"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieves a list of Procurement objects, representing the associations between products and Procurementions. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "procurements",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Procurement"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "procurement-items": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/procurements/{procurement_id}/items",
      "description": "List procurement items",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "procurement_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Provide procurement ID to filter by"
              }
            },
            "required": [
              "procurement_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "A limit on the number of objects to return. Range: 1-100 (default is 10)"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves the items associated with a given procurement ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ProcurementItem"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "procurement-receive": {
      "risk": "H",
      "module": "products",
      "method": "PATCH",
      "path": "/procurements/{procurement_id}/receive",
      "description": "Receive procurement",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "procurement_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The unique identifier of the procurement record"
              }
            },
            "required": [
              "procurement_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "items": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.ReceiveProcurementParam"
                },
                "maxItems": 10,
                "description": "The array of items to update with received and rejected quantities"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Processes the receipt of procurement items by updating their quantities (received and rejected) and recording any rejection reasons. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.ReceiveProcurementParam": {
            "type": "object",
            "properties": {
              "procurement_item_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "received_quantity": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "rejected_quantity": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "rejected_reason": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "procurement_item_id"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": []
    },
    "procurement-update": {
      "risk": "H",
      "module": "products",
      "method": "PUT",
      "path": "/procurements/{procurement_id}",
      "description": "Update procurement",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "procurement_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The unique identifier of the procurement record to update"
              }
            },
            "required": [
              "procurement_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "procurement": {
                "$ref": "#/$defs/v202506.UpdateProcurementParam",
                "description": "Procurement"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Allows updating the details of an existing procurement record, such as its supplier, note, or other properties. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateProcurementParam": {
            "type": "object",
            "properties": {
              "supplier_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "procurement",
          "type": "object",
          "schema": "v202506.Procurement",
          "has_id": true
        }
      ]
    },
    "supplier-create": {
      "risk": "W",
      "module": "products",
      "method": "POST",
      "path": "/suppliers",
      "description": "Create supplier",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "supplier": {
                "$ref": "#/$defs/v202506.CreateSupplierParam",
                "description": "Object containing supplier details"
              }
            },
            "required": [
              "supplier"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Allows users to add a new supplier to the system. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateSupplierParam": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "url": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "title"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "supplier",
          "type": "object",
          "schema": "v202506.Supplier",
          "has_id": true
        }
      ]
    },
    "supplier-detail": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/suppliers/{id}",
      "description": "Get supplier",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Supplier ID to query"
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
        "additionalProperties": false,
        "description": "Retrieves the detailed information of a specific supplier by its unique identifier (id). Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "supplier",
          "type": "object",
          "schema": "v202506.Supplier",
          "has_id": true
        }
      ]
    },
    "suppliers": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/suppliers",
      "description": "List suppliers",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "Maximum number of results per page. Acceptable range: 1 to 100. Default is 10"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "ids": {
                "type": "array",
                "items": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,19})$",
                      "maxLength": 20
                    }
                  ],
                  "x-integer-format": "uint64"
                },
                "maxItems": 100,
                "description": "A list of supplier IDs to filter results. Empty value retrieves all suppliers. Example: ?ids=1001&ids=1002"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Allows users to retrieve a list of suppliers with optional filtering by specific supplier IDs. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "suppliers",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Supplier"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "supplier-update": {
      "risk": "W",
      "module": "products",
      "method": "PUT",
      "path": "/suppliers/{id}",
      "description": "Update supplier",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Supplier ID to update"
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
              "supplier": {
                "$ref": "#/$defs/v202506.UpdateSupplierParam",
                "description": "Object containing supplier details"
              }
            },
            "required": [
              "supplier"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Updates the details of an existing supplier by its unique identifier (id). Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateSupplierParam": {
            "type": "object",
            "properties": {
              "url": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "url"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "supplier",
          "type": "object",
          "schema": "v202506.Supplier",
          "has_id": true
        }
      ]
    },
    "product-update": {
      "risk": "H",
      "module": "products",
      "method": "PUT",
      "path": "/products/{product_id}",
      "description": "Update product",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Product's ID"
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
              "product": {
                "$ref": "#/$defs/v202506.UpdateProductParam",
                "description": "Product"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Update an existing product with the provided details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateProductParam": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "brief": {
                "type": "string",
                "maxLength": 262144
              },
              "description": {
                "type": "string",
                "maxLength": 262144
              },
              "published": {
                "type": "boolean"
              },
              "require_shipping": {
                "type": "boolean"
              },
              "taxable": {
                "type": "boolean"
              },
              "tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "vendor": {
                "type": "string",
                "maxLength": 262144
              },
              "vendor_url": {
                "type": "string",
                "maxLength": 262144
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_title": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_description": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "handle": {
                "type": "string",
                "maxLength": 262144
              },
              "has_only_default_variant": {
                "type": "boolean"
              },
              "inventory_tracking": {
                "type": "boolean"
              },
              "inventory_policy": {
                "type": "string",
                "maxLength": 262144
              },
              "inventory_quantity": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "spu": {
                "type": "string",
                "maxLength": 262144
              },
              "fake_sales": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "display_fake_sales": {
                "type": "boolean"
              },
              "images": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateProductImage"
                },
                "maxItems": 10
              },
              "options": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.Option"
                },
                "maxItems": 10
              },
              "variants": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateProductVariant"
                },
                "maxItems": 10
              },
              "collection_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "need_variant_image": {
                "type": "boolean"
              },
              "need_shipping": {
                "type": "boolean"
              },
              "auto_publish_at": {
                "type": "string",
                "maxLength": 262144
              },
              "category_id": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202506.UpdateProductImage": {
            "type": "object",
            "properties": {
              "src": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "width": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "height": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "alt": {
                "type": "string",
                "maxLength": 262144
              },
              "id": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202506.Option": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "values": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1
              }
            },
            "required": [
              "name",
              "values"
            ],
            "additionalProperties": false
          },
          "v202506.UpdateProductVariant": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144
              },
              "option1": {
                "type": "string",
                "maxLength": 262144
              },
              "option2": {
                "type": "string",
                "maxLength": 262144
              },
              "option3": {
                "type": "string",
                "maxLength": 262144
              },
              "image": {
                "$ref": "#/$defs/v202506.UpdateProductImage"
              },
              "compare_at_price": {
                "type": "number"
              },
              "price": {
                "type": "number",
                "minimum": 0
              },
              "sku": {
                "type": "string",
                "maxLength": 262144
              },
              "barcode": {
                "type": "string",
                "maxLength": 262144
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "weight": {
                "type": "number"
              },
              "weight_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "cost_price": {
                "type": "number"
              },
              "wholesale_price": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateWholePrice"
                },
                "maxItems": 10
              },
              "whole_prices": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateWholePrice"
                },
                "maxItems": 10
              },
              "retail_price": {
                "type": "number"
              },
              "image_id": {
                "type": "string",
                "maxLength": 262144
              },
              "extend": {
                "$ref": "#/$defs/v202506.ExtendParam"
              },
              "inventory_quantity": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202506.UpdateWholePrice": {
            "type": "object",
            "properties": {
              "price": {
                "type": "number",
                "minimum": 0
              },
              "min_quantity": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "x-integer-minimum": "0"
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202506.ExtendParam": {
            "type": "object",
            "properties": {
              "length": {
                "type": "number"
              },
              "width": {
                "type": "number"
              },
              "height": {
                "type": "number"
              },
              "dimension_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "origin_country_code": {
                "type": "string",
                "maxLength": 262144
              },
              "hs_code": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "product",
          "type": "object",
          "schema": "v202506.ProductRes",
          "has_id": true
        }
      ]
    },
    "variant-count": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/products/{product_id}/variants/count",
      "description": "Count variants",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The product ID to count variants for"
              }
            },
            "required": [
              "product_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Count the number of variants for a specific product. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int64"
        }
      ]
    },
    "variant-create": {
      "risk": "H",
      "module": "products",
      "method": "POST",
      "path": "/products/{product_id}/variants",
      "description": "Create variant",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The product ID of the variant"
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
              "variant": {
                "$ref": "#/$defs/v202506.CreateVariantParam",
                "description": "The variant details"
              }
            },
            "required": [
              "variant"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a new product variant with the specified details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateVariantParam": {
            "type": "object",
            "properties": {
              "option1": {
                "type": "string",
                "maxLength": 262144
              },
              "option2": {
                "type": "string",
                "maxLength": 262144
              },
              "option3": {
                "type": "string",
                "maxLength": 262144
              },
              "image_id": {
                "type": "string",
                "maxLength": 262144
              },
              "compare_at_price": {
                "type": "number"
              },
              "price": {
                "type": "number",
                "minimum": 0
              },
              "sku": {
                "type": "string",
                "maxLength": 262144
              },
              "barcode": {
                "type": "string",
                "maxLength": 262144
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "inventory_quantity": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "weight": {
                "type": "number"
              },
              "weight_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "cost_price": {
                "type": "number"
              },
              "wholesale_price": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.WholePrice"
                },
                "maxItems": 10
              },
              "retail_price": {
                "type": "number"
              },
              "position": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "extend": {
                "$ref": "#/$defs/v202506.VariantExtend"
              }
            },
            "required": [
              "price",
              "position"
            ],
            "additionalProperties": false
          },
          "v202506.WholePrice": {
            "type": "object",
            "properties": {
              "price": {
                "type": "number",
                "minimum": 0
              },
              "min_quantity": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "x-integer-minimum": "0"
              }
            },
            "required": [
              "price",
              "min_quantity"
            ],
            "additionalProperties": false
          },
          "v202506.VariantExtend": {
            "type": "object",
            "properties": {
              "length": {
                "type": "number"
              },
              "width": {
                "type": "number"
              },
              "height": {
                "type": "number"
              },
              "dimension_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "origin_country_code": {
                "type": "string",
                "maxLength": 262144
              },
              "hs_code": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "variant",
          "type": "object",
          "schema": "v202506.VariantParam",
          "has_id": true
        }
      ]
    },
    "variant-delete": {
      "risk": "D",
      "module": "products",
      "method": "DELETE",
      "path": "/products/{product_id}/variants/{variant_id}",
      "description": "Delete variant",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The product ID of the variant"
              },
              "variant_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The variant ID to delete"
              }
            },
            "required": [
              "product_id",
              "variant_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Delete a product variant by its ID. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "variant-detail": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/variants/{variant_id}",
      "description": "Get variant",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "variant_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The variant ID"
              }
            },
            "required": [
              "variant_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve a product variant by its ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "variant",
          "type": "object",
          "schema": "v202506.VariantParam",
          "has_id": true
        }
      ]
    },
    "variants": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/products/{product_id}/variants",
      "description": "List variants",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The product ID to list variants for"
              }
            },
            "required": [
              "product_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve a list of all variants for a specific product. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "variants",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.VariantParam"
          }
        }
      ]
    },
    "variants-by-sku": {
      "risk": "R",
      "module": "products",
      "method": "GET",
      "path": "/products/sku/{sku}/variants",
      "description": "List variants by SKU",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "sku": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The variant SKU to list"
              }
            },
            "required": [
              "sku"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve a list of all variants for a specific SKU. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "variants",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.VariantParam"
          }
        }
      ]
    },
    "variant-update": {
      "risk": "H",
      "module": "products",
      "method": "PUT",
      "path": "/variants/{variant_id}",
      "description": "Update variant",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "variant_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The variant ID"
              }
            },
            "required": [
              "variant_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "variant": {
                "$ref": "#/$defs/v202506.UpdateVariantParam",
                "description": "The variant details"
              }
            },
            "required": [
              "variant"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update an existing product variant with the provided details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateVariantParam": {
            "type": "object",
            "properties": {
              "option1": {
                "type": "string",
                "maxLength": 262144
              },
              "option2": {
                "type": "string",
                "maxLength": 262144
              },
              "option3": {
                "type": "string",
                "maxLength": 262144
              },
              "image_id": {
                "type": "string",
                "maxLength": 262144
              },
              "image": {
                "$ref": "#/$defs/v202506.UpdateVariantImage"
              },
              "compare_at_price": {
                "type": "number"
              },
              "price": {
                "type": "number",
                "minimum": 0
              },
              "sku": {
                "type": "string",
                "maxLength": 262144
              },
              "barcode": {
                "type": "string",
                "maxLength": 262144
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "inventory_quantity": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "weight": {
                "type": "number"
              },
              "weight_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "cost_price": {
                "type": "number"
              },
              "wholesale_price": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateWholePrice"
                },
                "maxItems": 10
              },
              "whole_prices": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UpdateWholePrice"
                },
                "maxItems": 10
              },
              "retail_price": {
                "type": "number"
              },
              "position": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "extend": {
                "$ref": "#/$defs/v202506.ExtendParam"
              }
            },
            "required": [
              "price"
            ],
            "additionalProperties": false
          },
          "v202506.UpdateVariantImage": {
            "type": "object",
            "properties": {
              "src": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "width": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "height": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "alt": {
                "type": "string",
                "maxLength": 262144
              },
              "path": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "src"
            ],
            "additionalProperties": false
          },
          "v202506.UpdateWholePrice": {
            "type": "object",
            "properties": {
              "price": {
                "type": "number",
                "minimum": 0
              },
              "min_quantity": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "x-integer-minimum": "0"
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202506.ExtendParam": {
            "type": "object",
            "properties": {
              "length": {
                "type": "number"
              },
              "width": {
                "type": "number"
              },
              "height": {
                "type": "number"
              },
              "dimension_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "origin_country_code": {
                "type": "string",
                "maxLength": 262144
              },
              "hs_code": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "variant",
          "type": "object",
          "schema": "v202506.VariantParam",
          "has_id": true
        }
      ]
    },
    "variant-update-by-sku": {
      "risk": "H",
      "module": "products",
      "method": "PUT",
      "path": "/variants/sku/{sku}",
      "description": "Update variant by SKU",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "sku": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The variant SKU to update"
              }
            },
            "required": [
              "sku"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "refuse_multi_result": {
                "type": "boolean",
                "description": "the variant details to update \"false\": If SKU matches multiple sub-items, update the matched sub-items normally. \"true\": Rejects the update if the SKU matches more than one subitem"
              },
              "variant": {
                "$ref": "#/$defs/v202506.UpdateVariantParamBySKU",
                "description": "Product variant"
              }
            },
            "required": [
              "refuse_multi_result",
              "variant"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update a product variant by its SKU. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateVariantParamBySKU": {
            "type": "object",
            "properties": {
              "compare_at_price": {
                "type": "number"
              },
              "price": {
                "type": "number",
                "minimum": 0
              },
              "barcode": {
                "type": "string",
                "maxLength": 262144
              },
              "note": {
                "type": "string",
                "maxLength": 262144
              },
              "inventory_quantity": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "weight": {
                "type": "number"
              },
              "weight_unit": {
                "type": "string",
                "maxLength": 262144
              },
              "cost_price": {
                "type": "number"
              },
              "retail_price": {
                "type": "number"
              }
            },
            "required": [
              "price"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "variants",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.VariantParam"
          }
        }
      ]
    },
    "data-analysis-land-page": {
      "risk": "R",
      "module": "shop",
      "method": "POST",
      "path": "/data-analysis/land-page",
      "description": "Get data analysis land page",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "begin_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Start time, a Unix timestamp in seconds passed as a string, e.g. \"1748736000\""
              },
              "end_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "End time, a Unix timestamp in seconds passed as a string, e.g. \"1781481600\". Should be greater than begin_time"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 500,
                "default": 10,
                "description": "Page size for pagination"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field to sort by. Supported values: - `pv`: Page views - `uv`: Unique visitors - `add_cart_uv`: Unique visitors who added to cart - `begin_checkout_uv`: Unique visitors who began checkout - `add_payment_info_uv`: Unique visitors who added payment info - `orders`: Number of orders - `sales`: Total sales amount - `conversion_rate`: Conversion rate - `escape_rate`: Bounce rate - `avg_elapse`: Average time spent on page - `product_uv`: Unique visitors who viewed a product detail page - `order_customers`: Number of customers who placed an order"
              },
              "time_zone": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Notice: Values outside the range -12 to 14 might lead to unexpected results in time-based calculations. Time zone offset (in hours) used for analysis. Recommended range: -12 to 14"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sort order: asc (ascending), desc (descending)"
              },
              "dimensions": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "minItems": 1,
                "description": "Dimensions to retrieve. Supported values: - `land_url_path`: Landing page URL path - `last_template_name`: Page type - `last_referrer_show`: Last interactive source - `last_referrer_first_show`: Traffic type"
              },
              "filters": {
                "type": "string",
                "maxLength": 262144,
                "description": "Advanced filter conditions as a JSON string, expressed as a nested filter tree: - Array node `[ ... ]`: its children are combined with OR - Object node `{ ... }`: its entries are combined with AND - Leaf node: {\"operator\": \"...\", \"value\": ...} attached under a filter key The `value` type to send depends on the operator (operators are case-insensitive): - `in`, `not in`             -> value is an ARRAY, e.g. [\"a\", \"b\"]. A scalar will NOT match, so always send an array for these operators. - `like`, `not like`         -> value is a STRING, e.g. \"google\" - `=`, `>`, `>=`, `<`, `<=`  -> value is a SCALAR (string or number), e.g. 10 value is auto-converted to the target field type. Common keys: `land_url_path`, `last_template_name` (page type), `last_referrer_show` (traffic channel), `last_referrer_first_show` (traffic type). Unknown keys or unsupported operators are silently ignored, so a filter \"not taking effect\" usually means a mistyped key/operator. e.g. AND: {\"land_url_path\": {\"operator\": \"like\", \"value\": \"/\"}} OR : [{\"last_referrer_show\": {\"operator\": \"like\", \"value\": \"google\"}}, {\"last_referrer_show\": {\"operator\": \"like\", \"value\": \"facebook\"}}]"
              },
              "filter_crawler_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Crawler-filtering policy that controls whether bot/crawler traffic is excluded from the statistics. Values: - `no_filter_crawler`: do not filter; count all traffic (default) - `official_crawler`: exclude known crawlers/bots"
              }
            },
            "required": [
              "begin_time",
              "end_time",
              "dimensions"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Retrieve landing page analytics including page views, unique visitors, add-to-cart rate, checkout funnel, orders, sales, bounce rate, and average session duration, grouped by landing page URL. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "last_updated_at",
          "type": "string"
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "data",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.DataByLandPage"
          }
        }
      ]
    },
    "data-analysis-by-sku": {
      "risk": "R",
      "module": "shop",
      "method": "POST",
      "path": "/data-analysis/sku",
      "description": "Get data analysis by SKU",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "begin_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Start time, a Unix timestamp in seconds passed as a string, e.g. \"1748736000\""
              },
              "end_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "End time, a Unix timestamp in seconds passed as a string, e.g. \"1781481600\". Should be greater than begin_time"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 500,
                "default": 10,
                "description": "Page size for pagination"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field to sort by. Supported values: - `variant_op_updated_at`: Last updated time of the variant - `views_count`: Number of page views - `add_to_cart_count`: Number of add-to-cart actions - `order_count`: Number of orders - `sales_total`: Total sales amount - `net_sales_total`: Net sales amount - `add_to_cart_rate`: Add-to-cart rate - `add_to_cart_conversion_rate`: Add-to-cart conversion rate - `sales_count`: Number of items sold - `views_rate`: Page view rate"
              },
              "time_zone": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Notice: Values outside the range -12 to 14 might lead to unexpected results in time-based calculations. Time zone offset (in hours) used for analysis. Recommended range: -12 to 14"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sort order: asc (ascending), desc (descending)"
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by collection ID"
              },
              "sales_platform": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sales channel filter. Supported values: - `shopping_action`: Google Shopping Action - `shoplazza`: Online store - `mocart`: Mocart"
              },
              "keyword": {
                "type": "string",
                "maxLength": 262144,
                "description": "Keyword fuzzy search: title, ID, brief, SKU, SPU, tags, note"
              },
              "search_model": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filtering mode: base (default) or advanced. When set to advanced, the additional filter fields below take effect"
              },
              "collection_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by collection name"
              },
              "title": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by product title"
              },
              "tag_list": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by product tags"
              },
              "category": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by product category"
              },
              "sub_category": {
                "type": "boolean",
                "description": "Whether to include all sub-category levels in the search"
              },
              "cost_price_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Minimum cost price, e.g. \"1.99\""
              },
              "cost_price_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Maximum cost price, e.g. \"8.99\""
              },
              "product_note": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by product note / remark"
              },
              "vendor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by vendor / supplier name"
              },
              "created_at_min_at": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products created at or after this time, e.g. \"2026-04-01 00:00:00\""
              },
              "created_at_max_at": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products created at or before this time, e.g. \"2026-04-04 00:00:00\""
              },
              "filter_crawler_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Crawler-filtering policy that controls whether bot/crawler traffic is excluded from the statistics. Values: - `no_filter_crawler`: do not filter; count all traffic (default) - `official_crawler`: exclude known crawlers/bots"
              }
            },
            "required": [
              "begin_time",
              "end_time"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Provides merchants with detailed insights into sales data, enabling data-driven decision-making by analyzing products by SKU. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "last_updated_at",
          "type": "string"
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "data",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.DataBySku"
          }
        }
      ]
    },
    "data-analysis-by-spu": {
      "risk": "R",
      "module": "shop",
      "method": "POST",
      "path": "/data-analysis/spu",
      "description": "Get data analysis by SPU",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Type of resource to analyze. Supported values: `product`, `variant`, `collection`"
              },
              "begin_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Start time for retrieving analysis data: a Unix timestamp in seconds, passed as a string (e.g. \"1748736000\"). Must be less than end_time; typically the start of the day (00:00) in the relevant timezone"
              },
              "end_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "End time for retrieving analysis data: a Unix timestamp in seconds, passed as a string (e.g. \"1781481600\"). Must be greater than begin_time; typically the start of the following day (00:00) in the relevant timezone"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 500,
                "default": 10,
                "description": "Page size"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "time_zone": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Notice: Values outside the range -12 to 14 might lead to unexpected results in time-based calculations. Time zone offset (in hours) used for analysis. Recommended range: -12 to 14"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field to sort by. Supported values: - `created_at`: Product creation time - `first_published_at`: First publish time - `published_at`: Latest publish time - `product_op_updated_at`: Last product operation update time - `order_count`: Number of orders - `sales_count`: Number of items sold - `sales_total`: Total sales amount - `net_sales_total`: Net sales amount - `discount`: Discount amount - `tax`: Tax amount - `views_count`: Page view count - `add_to_cart_count`: Add-to-cart count - `add_to_cart_rate`: Add-to-cart rate - `view_client_count`: Unique viewer count - `add_cart_client_count`: Unique add-to-cart user count - `add_to_cart_conversion_rate`: Add-to-cart conversion rate - `transform_rate`: Overall conversion rate"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sorting direction: asc (ascending) or desc (descending)"
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by collection ID. When the collection ID is passed, results are filtered by that collection"
              },
              "keyword": {
                "type": "string",
                "maxLength": 262144,
                "description": "When the keyword is not empty, products are filtered. Keywords will fuzzy match these product fields: title, ID, brief, SKU, SPU, tags, note"
              },
              "search_model": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filtering mode: base (default) or advanced. When set to advanced, the `filter` field takes effect"
              },
              "filter": {
                "type": "string",
                "maxLength": 262144,
                "description": "Advanced filter conditions as a JSON string. Only takes effect when `search_model` is \"advanced\". Structure: a flat JSON object that maps each filter key to a leaf `{\"operator\": \"...\", \"value\": ...}`; multiple keys are combined with AND (this endpoint does not support OR groups). The `value` type to send depends on the operator (operators are case-insensitive): - `in` / `not in` -> value is an ARRAY of strings, e.g. `[\"SPU001\", \"SPU002\"]` - `like` / `not like` -> value is a STRING, e.g. `\"shirt\"` - `=` `>` `>=` `<` `<=` -> value is a SCALAR (string or number), e.g. `10` Key -> expected value: - list keys `spu` `sku` `product_id` `title` `tag_list` -> array - range keys `price_min`/`price_max`, `cost_price_min`/`cost_price_max`, `compare_at_price_min`/`compare_at_price_max`, `created_at_min`/`created_at_max`, `updated_at_min`/`updated_at_max` -> scalar - boolean keys `published` `sub_category` -> `\"true\"` / `\"false\"` - other keys `collection_id` `keyword` `vendor` `category` `product_note` `sales_platform` -> string Unknown keys are silently ignored (the request still returns 200), so a filter \"not taking effect\" usually means a mistyped key. e.g. `{\"spu\": {\"operator\": \"in\", \"value\": [\"SPU001\", \"SPU002\"]}}`"
              },
              "with_impression": {
                "type": "boolean",
                "description": "Whether to include impression data in the response"
              },
              "filter_crawler_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Crawler-filtering policy that controls whether bot/crawler traffic is excluded from the statistics. Values: - `no_filter_crawler`: do not filter; count all traffic (default) - `official_crawler`: exclude known crawlers/bots"
              },
              "sub_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Grouping granularity, only effective when `type` is \"collection\". Values: - `collection` (default): group by collection; `product_id` is empty - `collection_product`: group by collection x product - `product`: group by product"
              }
            },
            "required": [
              "type",
              "begin_time",
              "end_time"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Provides merchants with detailed insights into sales data, enabling data-driven decision-making by analyzing products by SPU. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "data",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.DataBySpu"
          }
        },
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "data-analysis-utm": {
      "risk": "R",
      "module": "shop",
      "method": "POST",
      "path": "/data-analysis/utm",
      "description": "Get data analysis UTM",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "begin_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Start time, a Unix timestamp in seconds passed as a string, e.g. \"1748736000\""
              },
              "end_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "End time, a Unix timestamp in seconds passed as a string, e.g. \"1781481600\". Should be greater than begin_time"
              },
              "time_zone": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Notice: Values outside the range -12 to 14 might lead to unexpected results in time-based calculations. Time zone offset (in hours) used for analysis. Recommended range: -12 to 14"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 500,
                "default": 10,
                "description": "Page size for pagination"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field to sort by. Supported values: - `view_client_count`: Number of unique visitors - `uv_rate`: Unique visitor rate - `product_views_count`: Number of product page views - `add_to_cart_count`: Number of add-to-cart actions - `begin_checkout_count`: Number of checkout initiations - `orders_count`: Number of orders - `orders_count_rate`: Order count rate - `transform_rate`: Overall conversion rate - `product_sales`: Product sales amount - `product_sales_rate`: Product sales rate - `per_customer_sales`: Average sales per customer - `avg_elapse`: Average session duration - `avg_depth`: Average page depth per session - `place_order_client_count`: Number of customers who placed orders - `first_order_customers`: Number of first-time order customers - `first_order_customers_rate`: First-time order customer rate - `date`: Date - `escape_rate`: Bounce rate"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sorting direction: asc (ascending) or desc (descending)"
              },
              "date_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Time granularity: empty string for totals, \"day\" for daily breakdown"
              },
              "filters": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202506.UTMFilter"
                },
                "maxItems": 100,
                "description": "Optional list of structured filters to narrow results by UTM dimension values Entries in the list are combined with AND. e.g. [{\"title\": \"utm_medium\", \"prerequisite\": \"includes\", \"values\": [\"123\"]}]"
              },
              "filter_crawler_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Crawler-filtering policy that controls whether bot/crawler traffic is excluded from the statistics. Values: - `no_filter_crawler`: do not filter; count all traffic (default) - `official_crawler`: exclude known crawlers/bots"
              }
            },
            "required": [
              "begin_time",
              "end_time"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Retrieve traffic source analytics grouped by UTM parameters (source, medium, campaign, term, content), with trend data over time. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UTMFilter": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144
              },
              "prerequisite": {
                "type": "string",
                "maxLength": 262144
              },
              "values": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              }
            },
            "required": [
              "title",
              "prerequisite"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "data",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.DataByUTM"
          }
        },
        {
          "name": "summary",
          "type": "object",
          "schema": "v202506.UTMSummary"
        }
      ]
    },
    "data-analysis-detail": {
      "risk": "R",
      "module": "shop",
      "method": "POST",
      "path": "/data-analysis",
      "description": "Get data analysis",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "begin_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Start time, a Unix timestamp in seconds passed as a string, e.g. \"1748736000\""
              },
              "end_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "End time, a Unix timestamp in seconds passed as a string, e.g. \"1781481600\". Should be greater than begin_time"
              },
              "indicator": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "minItems": 1,
                "description": "Metrics to query. Categorized into two groups based on the requested dimensions: Custom indicators (valid with custom dimensions): - `pv`: Page views - `uv`: Unique visitors - `add_cart_uv`: Unique visitors who added to cart - `add_cart_qty`: Add-to-cart quantity - `add_payment_info_uv`: Unique visitors who submitted payment info - `begin_checkout_pv`: Begin-checkout page views - `begin_checkout_uv`: Begin-checkout unique visitors - `orders`: Number of orders - `sales`: Total sales amount - `conversion_rate`: Conversion rate - `impression`: Impression count UTM indicators (valid with UTM dimensions): - `pv`: Page views - `uv`: Unique visitors - `add_cart_uv`: Unique visitors who added to cart - `begin_checkout_pv`: Begin-checkout page views - `begin_checkout_uv`: Begin-checkout unique visitors - `orders`: Number of orders - `sales`: Total sales amount"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200,
                "default": 10,
                "description": "Page size"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "time_zone": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Notice: Values outside the range -12 to 14 might lead to unexpected results in time-based calculations. Time zone offset (in hours) used for analysis. Recommended range: -12 to 14"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sort by field"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sorting direction: asc (ascending) or desc (descending)"
              },
              "dt_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Time granularity for aggregation: `dt_by_hour` (hourly), `dt_by_day` (daily)"
              },
              "dimension": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Notice: Mixing custom dimensions (e.g., country_code) with UTM-based dimensions will cause validation failure. Dimensions for the query. Categorized into two groups: Custom dimensions: - `country_code`: Country code UTM dimensions: - `utm_source`: UTM source - `utm_medium`: UTM medium - `utm_term`: UTM term - `utm_campaign`: UTM campaign - `utm_content`: UTM content"
              },
              "filters": {
                "type": "object",
                "additionalProperties": {
                  "type": "string",
                  "maxLength": 262144
                },
                "description": "Simple equality filters, keyed by dimension name with the exact value to match, e.g. {\"country_code\": \"US\"}. Each entry is an exact-match condition and multiple entries are combined with AND. Only keys within the supported `dimension` set take effect; unknown keys are ignored."
              },
              "filter_crawler_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Crawler-filtering policy that controls whether bot/crawler traffic is excluded from the statistics. Values: - `no_filter_crawler`: do not filter; count all traffic (default) - `official_crawler`: exclude known crawlers/bots"
              }
            },
            "required": [
              "begin_time",
              "end_time",
              "indicator"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Retrieve analytical data for the specified time range and dimensions. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "data",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.DataAnalysis"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "data-analysis-search-keyword": {
      "risk": "R",
      "module": "shop",
      "method": "POST",
      "path": "/data-analysis/search-keyword",
      "description": "Get data analysis by search keyword",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "begin_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Start time, a Unix timestamp in seconds passed as a string, e.g. \"1748736000\""
              },
              "end_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "End time, a Unix timestamp in seconds passed as a string, e.g. \"1781481600\". Should be greater than begin_time"
              },
              "time_zone": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Notice: Values outside the range -12 to 14 might lead to unexpected results in time-based calculations. Time zone offset (in hours) used for analysis. Recommended range: -12 to 14"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 600,
                "default": 10,
                "description": "Page size for pagination"
              },
              "keyword": {
                "type": "string",
                "maxLength": 500,
                "description": "Fuzzy match on the search keyword"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field to sort by. Supported values: - `count`: Number of searches - `percent`: Share of all searches - `uv`: Number of searching users - `has_result`: Whether the search returned results - `click_rate`: Search click-through rate"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sorting direction: asc (ascending) or desc (descending). Defaults to desc"
              },
              "has_result": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by whether the search returned results: `1` with results, `0` without results. Defaults to no filtering"
              },
              "country_code": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by the visitor's country/region code, e.g. \"US\""
              },
              "filter_crawler_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Crawler-filtering policy that controls whether bot/crawler traffic is excluded from the statistics. Values: - `no_filter_crawler`: do not filter; count all traffic (default) - `official_crawler`: exclude known crawlers/bots"
              }
            },
            "required": [
              "begin_time",
              "end_time"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Retrieve on-site search analytics grouped by search keyword, including the number of searches, the number of searching users, whether the search returned results, and the click-through rate. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "data",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.DataBySearchKeyword"
          }
        }
      ]
    },
    "data-analysis-traffic-channel": {
      "risk": "R",
      "module": "shop",
      "method": "POST",
      "path": "/data-analysis/traffic-channel",
      "description": "Get data analysis by traffic channel",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "begin_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Start time, a Unix timestamp in seconds passed as a string, e.g. \"1748736000\""
              },
              "end_time": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "End time, a Unix timestamp in seconds passed as a string, e.g. \"1781481600\". Should be greater than begin_time"
              },
              "dimensions": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "minItems": 1,
                "description": "Dimensions to group by. Supported values: - `last_referrer_first_show`: Traffic type (first-level channel) - `last_referrer_show`: Traffic channel (second-level channel)"
              },
              "metrics": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "minItems": 1,
                "description": "Metrics to query. Supported values: - `uv`: Number of visiting users - `sales`: Sales amount - `orders`: Number of orders - `uv_rate`: Share of visiting users against the grand total - `sales_rate`: Share of sales against the grand total - `orders_rate`: Share of orders against the grand total"
              },
              "time_zone": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Notice: Values outside the range -12 to 14 might lead to unexpected results in time-based calculations. Time zone offset (in hours) used for analysis. Recommended range: -12 to 14"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 500,
                "default": 10,
                "description": "Page size for pagination"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field to sort by. Must be one of the requested `metrics`; `uv_rate`, `sales_rate` and `orders_rate` sort by their underlying raw values"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sorting direction: asc (ascending) or desc (descending)"
              },
              "has_summary": {
                "type": "boolean",
                "description": "Whether to return the `summary` grand-total row"
              },
              "filters": {
                "type": "string",
                "maxLength": 262144,
                "description": "Dimension filter conditions as a JSON string, keyed by dimension name: `{\"<dimension>\": {\"operator\": \"<operator>\", \"value\": <value>}}` The `value` type to send depends on the operator (operators are case-insensitive): - `in`, `not in`             -> value is an ARRAY, e.g. [\"Social\"]. A scalar will NOT match, so always send an array for these operators. - `like`, `not like`         -> value is a STRING, e.g. \"google\" - `=`, `>`, `>=`, `<`, `<=`  -> value is a SCALAR (string or number) Supported keys are the two dimensions: `last_referrer_first_show` and `last_referrer_show`; entries are combined with AND. Unknown keys or unsupported operators are silently ignored, so a filter \"not taking effect\" usually means a mistyped key/operator. e.g. {\"last_referrer_first_show\": {\"operator\": \"in\", \"value\": [\"Social\"]}, \"last_referrer_show\": {\"operator\": \"in\", \"value\": [\"Facebook\", \"TikTok\"]}}"
              },
              "filter_crawler_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Crawler-filtering policy that controls whether bot/crawler traffic is excluded from the statistics. Values: - `no_filter_crawler`: do not filter; count all traffic (default) - `official_crawler`: exclude known crawlers/bots"
              }
            },
            "required": [
              "begin_time",
              "end_time",
              "dimensions",
              "metrics"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Retrieve traffic channel analytics grouped by traffic type and traffic channel, including visiting users, sales, orders and each of their shares of the grand total. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "last_updated_at",
          "type": "string"
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "data",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.DataByTrafficChannel"
          }
        },
        {
          "name": "summary",
          "type": "object",
          "schema": "v202601.DataByTrafficChannel"
        }
      ]
    },
    "data-analysis-traffic-channel-options": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/data-analysis/traffic-channel/options",
      "description": "Get traffic channel options",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve the complete traffic type (first-level) to traffic channel (second-level) mapping. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "traffic_channels",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.TrafficChannelOption"
          }
        }
      ]
    },
    "article-authors": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/articles/authors",
      "description": "List authors",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Return the list of distinct article authors. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "authors",
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ]
    },
    "article-count": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/articles/count",
      "description": "Get article count",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Return the total number of articles matching the given criteria. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "article-create": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/articles",
      "description": "Create article",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "article": {
                "$ref": "#/$defs/v202506.CreateArticleParam",
                "description": "Article data to be created"
              }
            },
            "required": [
              "article"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a new article with the provided details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateArticleParam": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 100,
                "minLength": 1
              },
              "excerpt": {
                "type": "string",
                "maxLength": 255
              },
              "content": {
                "type": "string",
                "maxLength": 262144
              },
              "published": {
                "type": "boolean"
              },
              "published_at": {
                "type": "string",
                "maxLength": 262144
              },
              "handle": {
                "type": "string",
                "maxLength": 262144
              },
              "author": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_title": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_description": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "blog_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "image": {
                "$ref": "#/$defs/v202506.ArticleImageParam"
              }
            },
            "required": [
              "title"
            ],
            "additionalProperties": false
          },
          "v202506.ArticleImageParam": {
            "type": "object",
            "properties": {
              "src": {
                "type": "string",
                "maxLength": 262144
              },
              "width": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "height": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "article",
          "type": "object",
          "schema": "v202506.Article",
          "has_id": true
        }
      ]
    },
    "article-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/articles/{id}",
      "description": "Delete article",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Article ID"
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
        "additionalProperties": false,
        "description": "Delete an article by its ID. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "article-detail": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/articles/{id}",
      "description": "Get article",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Article ID"
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
        "additionalProperties": false,
        "description": "Look up an article by its ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "article",
          "type": "object",
          "schema": "v202506.Article",
          "has_id": true
        }
      ]
    },
    "articles": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/articles",
      "description": "List articles",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "Page size, default 10"
              },
              "author": {
                "type": "string",
                "maxLength": 262144,
                "description": "Optional filter for author name"
              },
              "keyword": {
                "type": "string",
                "maxLength": 262144,
                "description": "Optional keyword to fuzzy-match article title/content"
              },
              "published": {
                "type": "boolean",
                "description": "Optional published-status filter: true = published only, false = drafts only, omit = all"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve a list of articles with optional filtering. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "articles",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Article"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "article-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/articles/{id}",
      "description": "Update article",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Article ID"
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
              "article": {
                "$ref": "#/$defs/v202506.UpdateArticleParam",
                "description": "Article data to be updated"
              }
            },
            "required": [
              "article"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update an existing article by its ID. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateArticleParam": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 100
              },
              "excerpt": {
                "type": "string",
                "maxLength": 255
              },
              "content": {
                "type": "string",
                "maxLength": 262144
              },
              "published": {
                "type": "boolean"
              },
              "published_at": {
                "type": "string",
                "maxLength": 262144
              },
              "handle": {
                "type": "string",
                "maxLength": 262144
              },
              "author": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_title": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_description": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "blog_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "image": {
                "$ref": "#/$defs/v202506.ArticleImageParam"
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202506.ArticleImageParam": {
            "type": "object",
            "properties": {
              "src": {
                "type": "string",
                "maxLength": 262144
              },
              "width": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              },
              "height": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "article",
          "type": "object",
          "schema": "v202506.Article",
          "has_id": true
        }
      ]
    },
    "blog-count": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/blogs/count",
      "description": "Get blog count",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve the total number of blogs. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "blog-create": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/blogs",
      "description": "Create blog",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "blog": {
                "$ref": "#/$defs/v202506.CreateBlogParam",
                "description": "Blog"
              }
            },
            "required": [
              "blog"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a new blog with the provided details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateBlogParam": {
            "type": "object",
            "properties": {
              "Title": {
                "type": "string",
                "maxLength": 100,
                "minLength": 1
              },
              "handle": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_title": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_description": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [
              "Title"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "blog",
          "type": "object",
          "schema": "v202506.Blog",
          "has_id": true
        }
      ]
    },
    "blog-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/blogs/{id}",
      "description": "Delete blog",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Blog ID"
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
        "additionalProperties": false,
        "description": "Delete a specific blog using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "blog-detail": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/blogs/{id}",
      "description": "Get blog",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Blog ID"
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
        "additionalProperties": false,
        "description": "Retrieve details of a specific blog using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "blog",
          "type": "object",
          "schema": "v202506.Blog",
          "has_id": true
        }
      ]
    },
    "blogs": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/blogs",
      "description": "List blogs",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "Page size, default 10"
              },
              "keyword": {
                "type": "string",
                "maxLength": 262144,
                "description": "Optional keyword to fuzzy-match blog title"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve a list of all blogs with pagination. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "blogs",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.Blog"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "blog-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/blogs/{id}",
      "description": "Update blog",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Blog ID"
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
              "blog": {
                "$ref": "#/$defs/v202506.UpdateBlogParam",
                "description": "Blog data to be updated"
              }
            },
            "required": [
              "blog"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update the details of an existing blog using its unique identifier. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateBlogParam": {
            "type": "object",
            "properties": {
              "Title": {
                "type": "string",
                "maxLength": 100
              },
              "handle": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_title": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_description": {
                "type": "string",
                "maxLength": 262144
              },
              "seo_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "blog",
          "type": "object",
          "schema": "v202506.Blog",
          "has_id": true
        }
      ]
    },
    "file-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/file/{file_uri}",
      "description": "Delete file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "file_uri": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier of the file to be deleted"
              }
            },
            "required": [
              "file_uri"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Delete a file by URI. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "file-detail": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/file/detail/{file_uri}",
      "description": "Get file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "file_uri": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier of the file"
              }
            },
            "required": [
              "file_uri"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Get details of a specific file. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "file",
          "type": "object",
          "schema": "v202506.File"
        }
      ]
    },
    "files": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/file",
      "description": "List files",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "folder": {
                "type": "string",
                "maxLength": 262144,
                "default": "all_upload",
                "description": "The folder name to fetch files from. Defaults to \"all_upload\". Allowed values: -product - all_upload"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 20,
                "description": "The number of files to retrieve per page. Defaults to 20 if not specified. Must be greater than 0 and less than or equal to 300"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "List files in the media library. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "files",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.File"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "file-upload-task": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/file/task/{task_id}",
      "description": "Get upload file task",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "task_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The unique identifier of the upload task"
              }
            },
            "required": [
              "task_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Get the status and result of an upload task. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "task_id",
          "type": "string"
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "finished",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "status",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "success_list",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.FileList"
          }
        },
        {
          "name": "failure_list",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "origin_list",
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ]
    },
    "file-create": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/file",
      "description": "Create upload file",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "original_source_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "A list of original file URLs to be uploaded. Each URL must be a valid link pointing to a file to process.Original source list, picture link, for example: [\"https://picx.zhimg.com/v2-3b4fc7e3a1195a081d0259246c38debc_720w.jpg?source=172ae18b\"]"
              }
            },
            "required": [
              "original_source_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Create an upload task for one or more files. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "task_id",
          "type": "string"
        }
      ]
    },
    "shop-detail": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/shop",
      "description": "Get shop",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "fields": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Specifies which fields to include in the response. Example: ?fields=id&fields=name"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Get the current shop details. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "account",
          "type": "string"
        },
        {
          "name": "address1",
          "type": "string"
        },
        {
          "name": "address2",
          "type": "string"
        },
        {
          "name": "city",
          "type": "string"
        },
        {
          "name": "country_code",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "customer_email",
          "type": "string"
        },
        {
          "name": "domain",
          "type": "string"
        },
        {
          "name": "email",
          "type": "string"
        },
        {
          "name": "icon",
          "type": "object",
          "schema": "v202506.Icon"
        },
        {
          "name": "subscription",
          "type": "object",
          "schema": "v202506.SubscriptionStatus"
        },
        {
          "name": "id",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "phone",
          "type": "string"
        },
        {
          "name": "primary_locale",
          "type": "string"
        },
        {
          "name": "province_code",
          "type": "string"
        },
        {
          "name": "root_url",
          "type": "string"
        },
        {
          "name": "shop_owner",
          "type": "string"
        },
        {
          "name": "state",
          "type": "string"
        },
        {
          "name": "system_domain",
          "type": "string"
        },
        {
          "name": "timezone",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "zip",
          "type": "string"
        }
      ]
    },
    "shop-update": {
      "risk": "H",
      "module": "shop",
      "method": "PATCH",
      "path": "/shop/{shop_id}",
      "description": "Update shop details",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "shop_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Specifies which shop is to be updated"
              }
            },
            "required": [
              "shop_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "shop": {
                "$ref": "#/$defs/v202506.UpdateShopParam",
                "description": "Shop"
              }
            },
            "required": [
              "shop"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update editable shop attributes. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateShopParam": {
            "type": "object",
            "properties": {
              "customer_email": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "account",
          "type": "string"
        },
        {
          "name": "address1",
          "type": "string"
        },
        {
          "name": "address2",
          "type": "string"
        },
        {
          "name": "city",
          "type": "string"
        },
        {
          "name": "country_code",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "customer_email",
          "type": "string"
        },
        {
          "name": "domain",
          "type": "string"
        },
        {
          "name": "email",
          "type": "string"
        },
        {
          "name": "icon",
          "type": "object",
          "schema": "v202506.Icon"
        },
        {
          "name": "subscription",
          "type": "object",
          "schema": "v202506.SubscriptionStatus"
        },
        {
          "name": "id",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "phone",
          "type": "string"
        },
        {
          "name": "primary_locale",
          "type": "string"
        },
        {
          "name": "province_code",
          "type": "string"
        },
        {
          "name": "root_url",
          "type": "string"
        },
        {
          "name": "shop_owner",
          "type": "string"
        },
        {
          "name": "state",
          "type": "string"
        },
        {
          "name": "system_domain",
          "type": "string"
        },
        {
          "name": "timezone",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "zip",
          "type": "string"
        }
      ]
    },
    "language-add": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/languages",
      "description": "Add store languages",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "codes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "IETF language codes to add (e.g., [\"zh-CN\", \"ja-JP\"]). Each code must be one of the system supported languages; unsupported codes are silently dropped"
              }
            },
            "required": [
              "codes"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Add one or more store languages. Newly added languages are disabled by default. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "language-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/languages/{language_code}",
      "description": "Delete store language",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "language_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "IETF language code"
              }
            },
            "required": [
              "language_code"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Delete a store language. The language must be disabled first; only its configuration is removed and the translation corpus is retained. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "language-disable": {
      "risk": "D",
      "module": "shop",
      "method": "POST",
      "path": "/languages/{language_code}/disable",
      "description": "Disable store language",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "language_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "IETF language code"
              }
            },
            "required": [
              "language_code"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Disable a store language so it is hidden from visitors; configuration and translations are kept. A store must keep at least one enabled language; a primary market's default language and a market's last enabled language cannot be disabled. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "language-enable": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/languages/{language_code}/enable",
      "description": "Enable store language",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "language_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "IETF language code"
              }
            },
            "required": [
              "language_code"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Enable a store language so it is visible to storefront visitors. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "languages": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/languages",
      "description": "List store languages",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve store languages together with their market relations. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "languages",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.Language"
          }
        }
      ]
    },
    "language-markets": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/languages/markets",
      "description": "List configurable markets",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "List the markets a language can be configured (published) to. Use this before publishing a language to markets. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "markets",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.ConfigurableMarket"
          }
        }
      ]
    },
    "language-publish": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/languages/{language_code}/publish",
      "description": "Publish language to markets",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "language_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "IETF language code"
              }
            },
            "required": [
              "language_code"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "market_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "description": "Market IDs this language is configured to. Full replacement, NOT incremental. An empty array removes all market relations of this language"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Configure a language to one or more markets. Full replacement of market relations; an empty list removes all relations. A disabled language can be configured but does not take effect until enabled. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "supported-languages": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/languages/supported",
      "description": "List supported languages",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "List the languages the system supports. Use this to validate language codes before adding them; codes not in this list are silently dropped on add. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "languages",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.SupportedLanguage"
          }
        }
      ]
    },
    "market-products-add": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/markets/{id}/products",
      "description": "Add market products",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "Product IDs to add to this market"
              }
            },
            "required": [
              "product_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Add products to a market so the market sells them. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "market-create": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/markets",
      "description": "Create market",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 50,
                "minLength": 1,
                "description": "Market name. Maximum 50 characters. Must be unique within the store"
              },
              "countries": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "Covered countries, ISO 3166-1 alpha-2 codes in upper case (e.g., US, JP). A country may belong to only one market"
              },
              "confirm": {
                "type": "boolean",
                "description": "Confirmation flag. When false (default) and any country is already occupied by other markets, the request is rejected and the markets that would be deleted are returned. Resubmit with true to proceed; those occupied markets will be automatically deleted"
              }
            },
            "required": [
              "name",
              "countries"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a market with a name and covered countries. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "market",
          "type": "object",
          "schema": "v202601.Market",
          "has_id": true
        }
      ]
    },
    "market-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/markets/{id}",
      "description": "Delete market",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID. The primary market cannot be deleted. Deletion is irreversible"
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
        "additionalProperties": false,
        "description": "Permanently delete a market. The primary market cannot be deleted; deletion is irreversible. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "market-products-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/markets/{id}/products",
      "description": "Delete market products",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
              "product_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "Product IDs to remove from this market"
              }
            },
            "required": [
              "product_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Remove products from a market so the market stops selling them. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "market-detail": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/markets/{id}",
      "description": "Get market",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
        "additionalProperties": false,
        "description": "Retrieve full detail of a single market, including domain, pricing, tax, language and status. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "market",
          "type": "object",
          "schema": "v202601.Market",
          "has_id": true
        }
      ]
    },
    "markets": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/markets",
      "description": "List markets",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "only_active": {
                "type": "boolean",
                "description": "Whether to return only active markets. Defaults to false"
              },
              "with_countries_detail": {
                "type": "boolean",
                "description": "Whether to include per-country currency detail. Defaults to false"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve all markets of the store with their configuration. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "markets",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.MarketListItem"
          }
        }
      ]
    },
    "market-languages": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/markets/{id}/languages",
      "description": "List market languages",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
        "additionalProperties": false,
        "description": "List the languages configured on a market, including each language's enabled and default status. Use this before setting the market's default language. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "languages",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.MarketLanguage"
          }
        }
      ]
    },
    "market-products": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/markets/{id}/products",
      "description": "List market products",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
              "is_excluded": {
                "type": "boolean",
                "description": "Filter by exclusion status: true returns only excluded products, false returns only included products, omit to return all"
              },
              "keyword": {
                "type": "string",
                "maxLength": 262144,
                "description": "Search keyword matched against product title"
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter products belonging to a specific collection"
              },
              "sort_by": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field to sort by"
              },
              "sort_direction": {
                "type": "string",
                "maxLength": 262144,
                "description": "Sort direction (e.g., asc or desc)"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "A limit on the number of objects to return. Range: 1-100 (default is 10)"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "List the products of a market, this returns each product's on-sale status in this market and its price in the market's currency. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "total_count",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "included_count",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "excluded_count",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "symbol",
          "type": "object",
          "schema": "v202601.MarketCurrencySymbol"
        },
        {
          "name": "products",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.MarketProduct"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "market-preview": {
      "risk": "R",
      "module": "shop",
      "method": "POST",
      "path": "/markets/preview",
      "description": "Preview markets to be deleted",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "countries": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "minItems": 1,
                "description": "Countries to claim, ISO 3166-1 alpha-2 codes in upper case (e.g., US, JP). Because a country may belong to only one market, any other market whose countries are all claimed here will be automatically deleted"
              },
              "except_market_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Market ID to exclude from the check"
              }
            },
            "required": [
              "countries"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Given a set of countries, preview which existing markets would be fully claimed and therefore automatically deleted. Call this before creating or updating a market so the caller knows which markets will be removed. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "markets",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.MarketDeletionItem"
          }
        }
      ]
    },
    "market-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/markets/{id}",
      "description": "Update market",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
                "maxLength": 50,
                "description": "New market name. Maximum 50 characters. Omit to keep unchanged"
              },
              "countries": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "description": "Covered countries (ISO 3166-1 alpha-2 upper case). Full replacement, NOT incremental. Omit to keep unchanged"
              },
              "confirm": {
                "type": "boolean",
                "description": "Confirmation flag for country occupation, same semantics as in market creation"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Update a market's name or covered countries. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "market-default-language-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/markets/{id}/default-language",
      "description": "Update market default language",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
              "language_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "IETF language code (e.g., zh-CN). The language must already be published to this market and enabled. For the primary market, changing the default language also changes the store default language"
              }
            },
            "required": [
              "language_code"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Set the default language of a market. The language must already be published to the market and enabled. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "market-domain-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/markets/{id}/domain",
      "description": "Update market domain",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
              "domain_type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Domain mode. Allowed values: - `primary`: use a primary (independent) domain - `sub_path`: use a sub-path suffix under the primary domain For a non-primary market, switching domain_type deletes all existing language configurations of this market and re-copies them from the primary market."
              },
              "domain_value": {
                "type": "string",
                "maxLength": 255,
                "description": "Domain value. Maximum 255 characters; letters, digits and underscore only. Required when domain_type is sub_path. The sub-path must not clash with a language code abbreviation (e.g., ca)"
              }
            },
            "required": [
              "domain_type"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Change a market's domain mode (primary domain or sub-path). Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "market-price-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/markets/{id}/price",
      "description": "Update market price",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
              "currency": {
                "type": "string",
                "maxLength": 262144,
                "description": "Base currency, ISO 4217 three-letter code in upper case (e.g., USD). Must be supplied with the current currency even when only adjusting price. Switching currency clears all fixed prices already set for products in this market"
              },
              "price_adjust": {
                "type": "integer",
                "minimum": -99,
                "maximum": 999,
                "description": "Price adjustment percentage. Range -99 to 999; positive raises price, negative lowers it. Pass 0 for no adjustment"
              },
              "local_currency_enabled": {
                "type": "boolean",
                "description": "Whether the local-currency display is enabled for this market"
              }
            },
            "required": [
              "currency"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Change a market's base currency, price adjustment and local-currency display. Custom exchange rate is not supported. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "market-products-price-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/markets/{id}/products/price",
      "description": "Update market product prices",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
              "products": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.MarketProductPriceItem"
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "Per-product fixed-price operations"
              }
            },
            "required": [
              "products"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Set or remove fixed prices of products in a market. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.MarketProductPriceItem": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144
              },
              "operation": {
                "type": "string",
                "maxLength": 262144
              },
              "fixed_price": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "id",
              "operation"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": []
    },
    "market-status-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/markets/{id}/status",
      "description": "Update market status",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
              "status": {
                "type": "string",
                "maxLength": 262144,
                "description": "Market status. Allowed values: - `active`: market is enabled - `paused`: market is paused; customers cannot check out. The primary market cannot be paused"
              }
            },
            "required": [
              "status"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Enable or pause a market. The primary market cannot be paused; pausing a market prevents customers from checking out. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "market-tax-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/markets/{id}/tax",
      "description": "Update market tax",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Market ID"
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
              "product_tax_included": {
                "type": "boolean",
                "description": "Whether product prices already include tax"
              }
            },
            "required": [
              "product_tax_included"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Change whether product prices include tax. This is the only update allowed on the primary market. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "menu-create": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/menus",
      "description": "Create menu",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Menu title"
              },
              "category": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Menu category. This endpoint creates custom menus only (`3`); built-in menus are maintained by the platform. Defaults to `3` when omitted"
              },
              "children": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": true
                },
                "maxItems": 10,
                "description": "Menu items tree. Each item has `title`, `type` (required, e.g. `home`, `collection`, `page`), `url`, `children`, etc."
              }
            },
            "required": [
              "title"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a custom menu for the store. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "menu",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "menu-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/menus/{id}",
      "description": "Delete menu",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Menu id to delete (custom category only)"
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
        "additionalProperties": false,
        "description": "Delete a custom menu. Built-in menus cannot be deleted. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "state",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "msg",
          "type": "string"
        }
      ]
    },
    "menus-list": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/menus",
      "description": "List menus",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Optional menu ids to filter; empty = all menus"
              },
              "hide_disabled": {
                "type": "boolean",
                "description": "When true, hide disabled menu items"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Page size, defaults to 100"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "List the store's menus (navigation). Supports filtering by ids and hiding disabled items. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "menus",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "google.protobuf.Struct"
          }
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "page",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "limit",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "menu-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/menus/{id}",
      "description": "Update menu",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Menu id to update"
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
              "title": {
                "type": "string",
                "maxLength": 262144,
                "description": "New title. Optional; kept unchanged when omitted"
              },
              "category": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Menu category (custom menu = `3`). Optional; `0` or omitted keeps the current value"
              },
              "children": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": true
                },
                "maxItems": 10,
                "description": "Menu items tree. Omitted or an empty array both keep the current items"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Update a menu's name and items. Built-in menus only allow a limited set of fields to change. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "menu",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "metafield-definition-count": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/metafield_definition/{owner_resource}/count",
      "description": "Count metafield by definition",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "owner_resource": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Resource type the metafield definitions are attached to: - `shop`: Shop - `product`: Product - `product_image`: Product image - `product_variant`: Product variant - `order`: Order - `page`: Custom page - `customer`: Customer - `collection`: Collection - `blog`: Blog - `article`: Article - `app`: App"
              }
            },
            "required": [
              "owner_resource"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "definition_ids": {
                "type": "array",
                "items": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,19})$",
                      "maxLength": 20
                    }
                  ],
                  "x-integer-format": "uint64"
                },
                "maxItems": 100,
                "minItems": 1,
                "description": "Array of metafield definition IDs to count. Example: ?definition_ids=1001&definition_ids=1002"
              }
            },
            "required": [
              "definition_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "query"
        ],
        "additionalProperties": false,
        "description": "Retrieve the count of metafields by definition IDs. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.DefinitionCount"
          }
        }
      ]
    },
    "metafield-definition-count-by-group": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/metafield_definition/group_count",
      "description": "Get metafield definition count by group",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve the count of metafield definitions by group. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.DefinitionCountByGroup"
          }
        }
      ]
    },
    "metafield-definition-create": {
      "risk": "W",
      "module": "shop",
      "method": "POST",
      "path": "/metafield_definition/{owner_resource}",
      "description": "Create metafield definition",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "owner_resource": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Resource type the metafield definition is attached to: - `shop`: Shop - `product`: Product - `product_image`: Product image - `product_variant`: Product variant - `order`: Order - `page`: Custom page - `customer`: Customer - `collection`: Collection - `blog`: Blog - `article`: Article - `app`: App"
              }
            },
            "required": [
              "owner_resource"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "namespace": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "A container for a group of metafields. Grouping metafields within a namespace prevents your metafields from conflicting with other metafields with the same key name. For example, \"global\""
              },
              "key": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The key of the metafield (unique within the namespace). For example, \"color\""
              },
              "description": {
                "type": "string",
                "maxLength": 262144,
                "description": "A brief description of the metafield definition"
              },
              "type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Field type of the metafield: - `date`: Date - `date_time`: Date and time - `weight`: Weight - `volume`: Volume - `dimension`: Dimension - `integer`: Integer - `number_decimal`: Decimal - `file_reference`: File reference - `single_line_text_field`: Single-line text - `multi_line_text_field`: Multi-line text - `json`: JSON - `color`: Color - `rating`: Rating - `url`: URL - `boolean`: Boolean (true or false) - `string`: String"
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Name of the metafield definition"
              }
            },
            "required": [
              "namespace",
              "key",
              "type",
              "name"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a new metafield definition. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafield_definition",
          "type": "object",
          "schema": "v202506.MetafieldDefinition",
          "has_id": true
        }
      ]
    },
    "metafield-definition-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/metafield_definition/{id}",
      "description": "Delete metafield definition",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "The unique identifier for the metafield definition"
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
        "additionalProperties": false,
        "description": "Delete a metafield definition by its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "metafield-definition-detail": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/metafield_definition",
      "description": "Get metafield definition",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "The unique identifier for the metafield definition"
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false,
        "description": "Retrieve a metafield definition by its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafield_definition",
          "type": "object",
          "schema": "v202506.MetafieldDefinition",
          "has_id": true
        }
      ]
    },
    "metafield-definitions": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/metafield_definition/{owner_resource}",
      "description": "List metafield definitions",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "owner_resource": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Resource type the metafield definition is attached to: - `shop`: Shop - `product`: Product - `product_image`: Product image - `product_variant`: Product variant - `order`: Order - `page`: Custom page - `customer`: Customer - `collection`: Collection - `blog`: Blog - `article`: Article - `app`: App"
              }
            },
            "required": [
              "owner_resource"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve a list of all metafield definitions. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "definitions",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.MetafieldDefinition"
          }
        }
      ]
    },
    "metafield-definition-update": {
      "risk": "W",
      "module": "shop",
      "method": "PUT",
      "path": "/metafield_definition/{id}",
      "description": "Update metafield definition",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "The unique identifier for the metafield definition"
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
              "description": {
                "type": "string",
                "maxLength": 262144,
                "description": "Updated description of the metafield definition"
              },
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Updated name of the metafield definition"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Update an existing metafield definition. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafield_definition",
          "type": "object",
          "schema": "v202506.MetafieldDefinition",
          "has_id": true
        }
      ]
    },
    "metafield-count": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/metafields/{owner_resource}/{owner_id}/count",
      "description": "Get metafield count",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "owner_resource": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Resource type the metafield is attached to: - `shop`: Shop - `product`: Product - `product_image`: Product image - `product_variant`: Product variant - `order`: Order - `page`: Custom page - `customer`: Customer - `collection`: Collection - `blog`: Blog - `article`: Article - `app`: App"
              },
              "owner_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The ID of the resource the metafield is attached to"
              }
            },
            "required": [
              "owner_resource",
              "owner_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Get the metafield count of a specific resource. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "total_count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "metafield-create": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/metafields/{owner_resource}/{owner_id}",
      "description": "Create metafield",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "owner_resource": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Resource type the metafield is attached to: - `shop`: Shop - `product`: Product - `product_image`: Product image - `product_variant`: Product variant - `order`: Order - `page`: Custom page - `customer`: Customer - `collection`: Collection - `blog`: Blog - `article`: Article - `app`: App"
              },
              "owner_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The ID of the resource the metafield is attached to"
              }
            },
            "required": [
              "owner_resource",
              "owner_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "definition_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The ID of the associated metafield definition"
              },
              "namespace": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "A container for a group of metafields. Grouping metafields within a namespace prevents your metafields from conflicting with other metafields with the same key name. For example, \"global\""
              },
              "key": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The key of the metafield (unique within the namespace). For example, \"color\""
              },
              "value": {
                "description": "The value of the metafield; its data type is determined by the `type` field. For example, { \"mediaContentType\": \"IMAGE\", \"image\": { \"path\": \"6181b00da510ae8cf04673695cecf4c8.jpg\", \"alt\": \"\", \"width\": 750, \"height\": 750, \"aspect_ratio\": 1, \"src\": \"https://cdn.shoplazza.com/6181b00da510ae8cf04673695cecf4c8.jpg\", \"size\": 775566 } }"
              },
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field type of the metafield: - `date`: Date - `date_time`: Date and time - `weight`: Weight - `volume`: Volume - `dimension`: Dimension - `integer`: Integer - `number_decimal`: Decimal - `file_reference`: File reference - `single_line_text_field`: Single-line text - `multi_line_text_field`: Multi-line text - `json`: JSON - `color`: Color - `rating`: Rating - `url`: URL - `boolean`: Boolean (true or false)"
              },
              "description": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "A brief description of the metafield"
              }
            },
            "required": [
              "definition_id",
              "namespace",
              "key",
              "value",
              "type"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a metafield for the specified resource. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafield",
          "type": "object",
          "schema": "v202506.ResourceMetafield",
          "has_id": true
        }
      ]
    },
    "metafield-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/metafields/{owner_resource}/{owner_id}/{id}",
      "description": "Delete metafield",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "owner_resource": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Resource type the metafield is attached to: - `shop`: Shop - `product`: Product - `product_image`: Product image - `product_variant`: Product variant - `order`: Order - `page`: Custom page - `customer`: Customer - `collection`: Collection - `blog`: Blog - `article`: Article - `app`: App"
              },
              "owner_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The ID of the resource the metafield is attached to"
              },
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The unique ID of the metafield to delete"
              }
            },
            "required": [
              "owner_resource",
              "owner_id",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Delete a metafield by ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafield",
          "type": "object",
          "schema": "v202506.ResourceMetafield",
          "has_id": true
        }
      ]
    },
    "metafield-detail": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/metafields/{owner_resource}/{owner_id}/{id}",
      "description": "Get metafield",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "owner_resource": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Resource type the metafield is attached to: - `shop`: Shop - `product`: Product - `product_image`: Product image - `product_variant`: Product variant - `order`: Order - `page`: Custom page - `customer`: Customer - `collection`: Collection - `blog`: Blog - `article`: Article - `app`: App"
              },
              "owner_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The ID of the resource the metafield is attached to"
              },
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The unique ID of the metafield to retrieve"
              }
            },
            "required": [
              "owner_resource",
              "owner_id",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Get a metafield by ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafield",
          "type": "object",
          "schema": "v202506.ResourceMetafield",
          "has_id": true
        }
      ]
    },
    "metafields": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/metafields/{owner_resource}/{owner_id}",
      "description": "List metafields",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "owner_resource": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Resource type the metafield is attached to: - `shop`: Shop - `product`: Product - `product_image`: Product image - `product_variant`: Product variant - `order`: Order - `page`: Custom page - `customer`: Customer - `collection`: Collection - `blog`: Blog - `article`: Article - `app`: App"
              },
              "owner_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The ID of the resource the metafield is attached to"
              }
            },
            "required": [
              "owner_resource",
              "owner_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "namespace": {
                "type": "string",
                "maxLength": 262144,
                "description": "A container for a group of metafields. Grouping metafields within a namespace prevents your metafields from conflicting with other metafields with the same key name. For example, \"global\""
              },
              "key": {
                "type": "string",
                "maxLength": 262144,
                "description": "The key of the metafield (unique within the namespace). For example, \"color\""
              },
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field type of the metafield: - `date`: Date - `date_time`: Date and time - `weight`: Weight - `volume`: Volume - `dimension`: Dimension - `integer`: Integer - `number_decimal`: Decimal - `file_reference`: File reference - `single_line_text_field`: Single-line text - `multi_line_text_field`: Multi-line text - `json`: JSON - `color`: Color - `rating`: Rating - `url`: URL - `boolean`: Boolean (true or false)"
              },
              "page_size": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "description": "Page size",
                "minimum": 1,
                "maximum": 100
              },
              "cursor": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Cursor for pagination"
              },
              "create_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter for metafields whose creation time is not earlier than this point. ISO-8601 format. For example, \"2022-12-02T09:46:30Z\""
              },
              "create_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter for metafields whose creation time is not later than this point. ISO-8601 format. For example, \"2022-12-02T09:46:30Z\""
              },
              "update_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter for metafields whose last update time is not earlier than this point. ISO-8601 format. For example, \"2022-12-02T09:46:30Z\""
              },
              "update_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter for metafields whose last update time is not later than this point. ISO-8601 format. For example, \"2022-12-02T09:46:30Z\""
              },
              "definition_ids": {
                "type": "array",
                "items": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,19})$",
                      "maxLength": 20
                    }
                  ],
                  "x-integer-format": "uint64"
                },
                "maxItems": 100,
                "description": "The metafield definition ID list. Example: ?definition_ids=1001&definition_ids=1002"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "List metafields of a specific resource. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafields",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ResourceMetafield"
          }
        },
        {
          "name": "next_cursor",
          "type": "integer",
          "format": "uint64"
        },
        {
          "name": "total_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "metafield-update": {
      "risk": "H",
      "module": "shop",
      "method": "PATCH",
      "path": "/metafields/{owner_resource}/{owner_id}/{id}",
      "description": "Update metafield",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The unique identifier for the metafield"
              },
              "owner_resource": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Resource type the metafield is attached to: - `shop`: Shop - `product`: Product - `product_image`: Product image - `product_variant`: Product variant - `order`: Order - `page`: Custom page - `customer`: Customer - `collection`: Collection - `blog`: Blog - `article`: Article - `app`: App"
              },
              "owner_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The ID of the resource the metafield is attached to"
              }
            },
            "required": [
              "id",
              "owner_resource",
              "owner_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "value": {
                "description": "The value of the metafield; its data type is determined by the `type` field"
              },
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Field type of the metafield: - `date`: Date - `date_time`: Date and time - `weight`: Weight - `volume`: Volume - `dimension`: Dimension - `integer`: Integer - `number_decimal`: Decimal - `file_reference`: File reference - `single_line_text_field`: Single-line text - `multi_line_text_field`: Multi-line text - `json`: JSON - `color`: Color - `rating`: Rating - `url`: URL - `boolean`: Boolean (true or false)"
              },
              "description": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "A brief description of the metafield"
              }
            },
            "required": [
              "value",
              "type"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update a metafield of the specified resource. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafield",
          "type": "object",
          "schema": "v202506.ResourceMetafield",
          "has_id": true
        }
      ]
    },
    "shop-metafield-count": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/metafields-shop/count",
      "description": "Get shop metafield count",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Get the total number of shop metafields. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "shop-metafield-create": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/metafields-shop",
      "description": "Create shop metafield",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "namespace": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "A container for a group of metafields. Grouping metafields within a namespace prevents your metafields from conflicting with other metafields with the same key name. For example, \"global\""
              },
              "key": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The key of the metafield (unique within the namespace). For example, \"color\""
              },
              "type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Metafield value type: - `JSON`: JSON value - `string`: String value"
              },
              "value": {
                "description": "The value of the metafield; its data type is determined by the `type` field. For example, \"red\""
              },
              "description": {
                "type": "string",
                "maxLength": 262144,
                "description": "A brief description of the metafield. For example, \"The color of the product\""
              },
              "definition_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The ID of the associated metafield definition. For example, \"123456\""
              }
            },
            "required": [
              "namespace",
              "key",
              "type",
              "value"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a new metafield for the current shop. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafield",
          "type": "object",
          "schema": "v202506.Metafield",
          "has_id": true
        }
      ]
    },
    "shop-metafield-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/metafields-shop/{id}",
      "description": "Delete shop metafield",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier for the metafield. For example, \"123456\""
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
        "additionalProperties": false,
        "description": "Delete a shop metafield by ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafield",
          "type": "object",
          "schema": "v202506.DeleteMetafield",
          "has_id": true
        }
      ]
    },
    "shop-metafield": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/metafields-shop/{id}",
      "description": "Get shop metafield",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier for the metafield. For example, \"123456\""
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
              "fields": {
                "type": "string",
                "maxLength": 262144,
                "description": "Comma-separated list of fields to include in the response. For example, \"ID,value,key\""
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Get details of a specific shop metafield. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafield",
          "type": "object",
          "schema": "v202506.Metafield",
          "has_id": true
        }
      ]
    },
    "shop-metafields": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/metafields-shop",
      "description": "List shop metafields",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "namespace": {
                "type": "string",
                "maxLength": 262144,
                "description": "A container for a group of metafields. Grouping metafields within a namespace prevents your metafields from conflicting with other metafields with the same key name. For example, \"global\""
              },
              "key": {
                "type": "string",
                "maxLength": 262144,
                "description": "The key of the metafield (unique within the namespace). For example, \"color\""
              },
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Metafield value type: - `JSON`: JSON value - `string`: String value"
              },
              "limit": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "default": 50,
                "description": "Maximum number of metafields to return per page. Default is 50",
                "minimum": 1,
                "maximum": 100
              },
              "cursor": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]{0,19})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "uint64",
                "description": "Cursor for pagination"
              },
              "fields": {
                "type": "string",
                "maxLength": 262144,
                "description": "Comma-separated list of fields to include in the response. For example, \"ID,value,key\""
              },
              "create_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter for metafields whose creation time is not later than this point. ISO-8601 format. For example, \"2023-01-01T00:00:00Z\""
              },
              "create_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter for metafields whose creation time is not earlier than this point. ISO-8601 format. For example, \"2023-01-01T00:00:00Z\""
              },
              "update_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter for metafields whose last update time is not later than this point. ISO-8601 format. For example, \"2023-01-01T00:00:00Z\""
              },
              "update_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter for metafields whose last update time is not earlier than this point. ISO-8601 format. For example, \"2023-01-01T00:00:00Z\""
              },
              "metafields": {
                "type": "object",
                "additionalProperties": {
                  "type": "string",
                  "maxLength": 262144
                },
                "description": "Additional metafield filter conditions in JSON string form. For example, {\"key\": \"value\"}"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "List metafields attached to the current shop. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafields",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Metafield"
          }
        },
        {
          "name": "cursor",
          "type": "integer",
          "format": "uint64"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "shop-metafield-update": {
      "risk": "H",
      "module": "shop",
      "method": "PATCH",
      "path": "/metafields-shop/{id}",
      "description": "Update shop metafield",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique identifier for the metafield. For example, \"123456\""
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
              "type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Metafield value type: - `JSON`: JSON value - `string`: String value"
              },
              "value": {
                "description": "The value of the metafield; its data type is determined by the `type` field. For example, \"red\""
              },
              "description": {
                "type": "string",
                "maxLength": 262144,
                "description": "A brief description of the metafield. For example, \"The color of the product\""
              }
            },
            "required": [
              "type",
              "value"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update an existing shop metafield. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "metafield",
          "type": "object",
          "schema": "v202506.Metafield",
          "has_id": true
        }
      ]
    },
    "custom-page-batch-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/pages/store-pages/batch",
      "description": "Batch delete pages",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "ids": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -2147483648,
                  "maximum": 2147483647
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "List of IDs"
              }
            },
            "required": [
              "ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Deletes multiple custom pages in a single request. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "custom-page-detail-batch": {
      "risk": "R",
      "module": "shop",
      "method": "POST",
      "path": "/pages/details",
      "description": "Batch get pages",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "ids": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -2147483648,
                  "maximum": 2147483647
                },
                "maxItems": 100,
                "minItems": 1,
                "description": "List of IDs"
              }
            },
            "required": [
              "ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Retrieves details for multiple custom pages in a single request. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "pages",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.CustomPage"
          }
        }
      ]
    },
    "custom-page-count": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/pages/count",
      "description": "Get page count",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "description": "The title of the page to filter by"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve the total number of pages. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "custom-page-create": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/pages",
      "description": "Create page",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "page": {
                "$ref": "#/$defs/v202506.CreateCustomPageParam",
                "description": "Page number"
              }
            },
            "required": [
              "page"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a new page with the provided details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateCustomPageParam": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "content": {
                "type": "string",
                "maxLength": 262144
              },
              "url": {
                "type": "string",
                "maxLength": 262144
              },
              "meta_title": {
                "type": "string",
                "maxLength": 262144
              },
              "meta_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "meta_description": {
                "type": "string",
                "maxLength": 262144
              },
              "independent_seo": {
                "type": "boolean"
              }
            },
            "required": [
              "title"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "page",
          "type": "object",
          "schema": "v202506.CustomPage",
          "has_id": true
        }
      ]
    },
    "custom-page-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/pages/{id}",
      "description": "Delete page",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "The ID of the page to delete"
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
        "additionalProperties": false,
        "description": "Delete a specific page using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "status",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "custom-page-detail": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/pages/{id}",
      "description": "Get page",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "The ID of the page"
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
        "additionalProperties": false,
        "description": "Retrieve details of a specific page using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "page",
          "type": "object",
          "schema": "v202506.CustomPage",
          "has_id": true
        }
      ]
    },
    "custom-pages": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/pages",
      "description": "List pages",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 10,
                "description": "Number of records per page. The default value is 10"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve a list of all pages with pagination. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "pages",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.CustomPage"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "custom-page-detail-search": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/pages/store-pages/info",
      "description": "Search page",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "url": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "URL"
              }
            },
            "required": [
              "url"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false,
        "description": "Searches custom pages by keyword or other filter criteria. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "page",
          "type": "object",
          "schema": "v202506.CustomPage",
          "has_id": true
        }
      ]
    },
    "custom-page-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/pages/{id}",
      "description": "Update page",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "The ID of the page to update"
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
              "page": {
                "$ref": "#/$defs/v202506.UpdateCustomPageParam",
                "description": "Page number"
              }
            },
            "required": [
              "page"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update the details of an existing page using its unique identifier. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateCustomPageParam": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "content": {
                "type": "string",
                "maxLength": 262144
              },
              "url": {
                "type": "string",
                "maxLength": 262144
              },
              "meta_title": {
                "type": "string",
                "maxLength": 262144
              },
              "meta_keywords": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              },
              "meta_description": {
                "type": "string",
                "maxLength": 262144
              },
              "independent_seo": {
                "type": "boolean"
              }
            },
            "required": [
              "title"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "page",
          "type": "object",
          "schema": "v202506.CustomPage",
          "has_id": true
        }
      ]
    },
    "url-redirect-create": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/redirects",
      "description": "Create URL redirect",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "redirect": {
                "$ref": "#/$defs/v202506.CreateUrlRedirectParam",
                "description": "The URL redirect to be created"
              }
            },
            "required": [
              "redirect"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a new url redirect with the provided details. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateUrlRedirectParam": {
            "type": "object",
            "properties": {
              "from_url": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "redirect_url": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "status": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "from_url",
              "redirect_url",
              "status"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "redirect",
          "type": "object",
          "schema": "v202506.UrlRedirect",
          "has_id": true
        }
      ]
    },
    "url-redirect-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/redirects/{id}",
      "description": "Delete URL redirect",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "description": "Redirect ID"
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
        "additionalProperties": false,
        "description": "Delete a specific url redirect using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "url-redirect": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/redirects/{id}",
      "description": "Get URL redirect",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "description": "Redirect ID"
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
        "additionalProperties": false,
        "description": "Retrieve details of a specific url redirect using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "redirect",
          "type": "object",
          "schema": "v202506.UrlRedirect",
          "has_id": true
        }
      ]
    },
    "url-redirects-detail": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/redirects",
      "description": "List URL redirects",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve a list of all url redirect with pagination. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "redirects",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.UrlRedirect"
          }
        }
      ]
    },
    "url-redirect-detail-search": {
      "risk": "R",
      "module": "shop",
      "method": "POST",
      "path": "/redirects/detail",
      "description": "Search URL redirect",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "from_url": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The original URL to search for a redirect"
              }
            },
            "required": [
              "from_url"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Searches URL redirect rules by path pattern or keyword. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "redirect",
          "type": "object",
          "schema": "v202506.UrlRedirect",
          "has_id": true
        }
      ]
    },
    "url-redirect-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/redirects/{id}",
      "description": "Update URL redirect",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64",
                "description": "Redirect ID"
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
              "redirect": {
                "$ref": "#/$defs/v202506.UpdateUrlRedirectParam",
                "description": "The URL redirect to be updated"
              }
            },
            "required": [
              "redirect"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update the details of an existing url redirect using its unique identifier. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateUrlRedirectParam": {
            "type": "object",
            "properties": {
              "from_url": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "redirect_url": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "status": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "from_url",
              "redirect_url",
              "status"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": []
    },
    "theme-app-disable": {
      "risk": "D",
      "module": "themes",
      "method": "POST",
      "path": "/themes/edit-sessions/{oseid}/apps/disable",
      "description": "Disable app embed",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              }
            },
            "required": [
              "oseid"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Document (template file) ID containing the skin section. Optional; empty -> server resolves index.liquid"
              },
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID whose app switches are updated; also resolves the default document and the rendering context"
              },
              "category": {
                "type": "string",
                "maxLength": 262144,
                "description": "Category: `app_embeds` or `script_tags`. Optional; only used to disambiguate when `block_id` is not unique"
              },
              "app_key": {
                "type": "string",
                "maxLength": 262144,
                "description": "App grouping key. Optional; empty -> server searches all groups by `block_id`"
              },
              "block_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Block identifier: `type` field for `app_embeds`, `id` field for `script_tags`"
              },
              "template_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Render-context template name; defaults to `index`"
              },
              "locale": {
                "type": "string",
                "maxLength": 262144,
                "description": "Rendering locale; defaults to en_US"
              }
            },
            "required": [
              "theme_id",
              "block_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Disable a specific app-embed block or script tag within an edit session. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "theme-app-enable": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/edit-sessions/{oseid}/apps/enable",
      "description": "Enable app embed",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              }
            },
            "required": [
              "oseid"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Document (template file) ID containing the skin section. Optional; empty -> server resolves index.liquid"
              },
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID whose app switches are updated; also resolves the default document and the rendering context"
              },
              "category": {
                "type": "string",
                "maxLength": 262144,
                "description": "Category: `app_embeds` or `script_tags`. Optional; only used to disambiguate when `block_id` is not unique"
              },
              "app_key": {
                "type": "string",
                "maxLength": 262144,
                "description": "App grouping key. Optional; empty -> server searches all groups by `block_id`"
              },
              "block_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Block identifier: `type` field for `app_embeds`, `id` field for `script_tags`"
              },
              "template_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Render-context template name; defaults to `index`"
              },
              "locale": {
                "type": "string",
                "maxLength": 262144,
                "description": "Rendering locale; defaults to en_US"
              }
            },
            "required": [
              "theme_id",
              "block_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Enable a specific app-embed block or script tag within an edit session. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "theme-extensions-list": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/extensions",
      "description": "List app extension cards",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "template": {
                "type": "string",
                "maxLength": 262144,
                "description": "Template name to filter installable blocks, e.g. index"
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Optional max number of results"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "List the app extension cards that can be added to a template, grouped by app. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "apps",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.ThemeExtensionApp"
          }
        }
      ]
    },
    "theme-apps-list": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/apps",
      "description": "List app embeds",
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
                "description": "Max number of app-embed blocks to return, default no cap. Does not affect `script_tag_apps`"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "List the embed cards (app embeds) provided by the store's installed apps, plus injected script\ntags. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "app_embeds",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "google.protobuf.Struct"
          }
        },
        {
          "name": "script_tag_apps",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.ScriptTagGroup"
          }
        }
      ]
    },
    "theme-section-add-block": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/edit-sessions/{oseid}/sections/{section_id}/blocks",
      "description": "Add block to a card",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "section_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Section instance ID inside the document; a global card id (`header`, `footer`, `announcement`, `cart_drawer`) also works"
              }
            },
            "required": [
              "oseid",
              "section_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document (template file) ID"
              },
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID (for rendering context url)"
              },
              "block": {
                "type": "object",
                "additionalProperties": true,
                "description": "The block object to add, e.g. `{type, settings}`"
              },
              "index": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "0-based insert position within the parent's blocks (the section root when `parent_path` is empty). Pass -1 (or any value past the end) to append. Omitted = 0 = insert at the front"
              },
              "parent_path": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -2147483648,
                  "maximum": 2147483647
                },
                "maxItems": 10,
                "description": "Ancestor index path from the section root to the parent block the new block is inserted into (each element a 0-based index into a blocks array); empty = insert at top-level. e.g. `parent_path=[1,0]` with `index=-1` appends into `section.blocks[1].blocks[0].blocks`"
              },
              "template_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Template name; defaults to file location without `.liquid`"
              },
              "locale": {
                "type": "string",
                "maxLength": 262144,
                "description": "Rendering locale; defaults to en_US"
              }
            },
            "required": [
              "doc_id",
              "theme_id",
              "block"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Append/insert a block into a card within an edit session. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "section",
          "type": "object",
          "schema": "google.protobuf.Struct"
        },
        {
          "name": "html",
          "type": "string"
        }
      ]
    },
    "theme-gen-block-create": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/edit-sessions/{oseid}/gen-blocks",
      "description": "Create AI card",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              }
            },
            "required": [
              "oseid"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "content": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Card liquid source; must contain a schema tag. `schema.name` inside is the merchant-visible display name (no uniqueness requirement)"
              }
            },
            "required": [
              "content"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Create an AI card from liquid code (must contain a `{% schema %}` tag) within an edit session.\nThe response `settings` is the card's full default config and can be used directly to place the\ncard on a page. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "revert_id",
          "type": "string"
        },
        {
          "name": "settings",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-gen-block-delete": {
      "risk": "D",
      "module": "themes",
      "method": "DELETE",
      "path": "/themes/edit-sessions/{oseid}/gen-blocks",
      "description": "Delete AI card",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              }
            },
            "required": [
              "oseid"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "The `card_type` (`blocks/` + file name without extension), e.g. `blocks/gen_1a0d523`"
              }
            },
            "required": [
              "type"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "query"
        ],
        "additionalProperties": false,
        "description": "Delete an AI card and remove it from every page of the theme. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "revert_id",
          "type": "string"
        }
      ]
    },
    "theme-gen-block-detail": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/edit-sessions/{oseid}/gen-blocks",
      "description": "Get AI card details",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              }
            },
            "required": [
              "oseid"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "The `card_type` (`blocks/` + file name without extension), e.g. `blocks/gen_1a0d523`"
              },
              "with_content": {
                "type": "boolean",
                "description": "When true, the response additionally carries the card source in `doc.content`"
              }
            },
            "required": [
              "type"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "query"
        ],
        "additionalProperties": false,
        "description": "Get an AI card's file info and its usage in the current session (whether it is saved, how many\ntimes it is used, etc.); pass `with_content=true` to include the card's source code. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "doc",
          "type": "object",
          "schema": "v202601.GenBlockDoc",
          "has_id": true
        },
        {
          "name": "saved",
          "type": "boolean"
        },
        {
          "name": "ref_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "instances",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-public-blocks-list": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/public-blocks",
      "description": "List public cards",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "template": {
                "type": "string",
                "maxLength": 262144,
                "description": "Template name to filter public blocks, e.g. index"
              },
              "theme": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme name, e.g. Nova 2023"
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Optional max number of results"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "List public cards available for a template or theme. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "apps",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.PublicBlockApp"
          }
        }
      ]
    },
    "theme-section-remove-block": {
      "risk": "D",
      "module": "themes",
      "method": "DELETE",
      "path": "/themes/edit-sessions/{oseid}/sections/{section_id}/blocks",
      "description": "Remove block from a card",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "section_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Section instance ID inside the document; a global card id (`header`, `footer`, `announcement`, `cart_drawer`) also works"
              }
            },
            "required": [
              "oseid",
              "section_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document (template file) ID"
              },
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID (for rendering context url)"
              },
              "block_index": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "0-based index of the block to remove within its parent's blocks (the section root when `parent_path` is empty)"
              },
              "parent_path": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -2147483648,
                  "maximum": 2147483647
                },
                "maxItems": 10,
                "description": "Ancestor index path from the section root to the target block's parent (each element a 0-based index into a blocks array); empty = top-level. e.g. `parent_path=[1,0]` with `block_index=2` removes `section.blocks[1].blocks[0].blocks[2]`"
              },
              "template_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Template name; defaults to file location without `.liquid`"
              },
              "locale": {
                "type": "string",
                "maxLength": 262144,
                "description": "Rendering locale; defaults to en_US"
              }
            },
            "required": [
              "doc_id",
              "theme_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Remove a block from a card by index within an edit session. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "section",
          "type": "object",
          "schema": "google.protobuf.Struct"
        },
        {
          "name": "html",
          "type": "string"
        }
      ]
    },
    "theme-gen-block-revert": {
      "risk": "D",
      "module": "themes",
      "method": "POST",
      "path": "/themes/edit-sessions/{oseid}/gen-blocks/revert",
      "description": "Revert AI card operation",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              }
            },
            "required": [
              "oseid"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "revert_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "32-character token taken from any write response (create / update / delete / revert itself); pass it back as-is. The same id may be used repeatedly"
              }
            },
            "required": [
              "revert_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Restore the card to its state before the operation identified by `revert_id` (returned by any\ncreate, update, delete, or revert). Reverting also returns a new `revert_id`, so you can undo\nand redo repeatedly. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "revert_id",
          "type": "string"
        }
      ]
    },
    "theme-section-set-slot": {
      "risk": "H",
      "module": "themes",
      "method": "PATCH",
      "path": "/themes/edit-sessions/{oseid}/sections/{section_id}/slot",
      "description": "Set block properties in a card",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "section_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Section instance ID inside the document; a global card id (`header`, `footer`, `announcement`, `cart_drawer`) also works"
              }
            },
            "required": [
              "oseid",
              "section_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document (template file) ID"
              },
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID (for rendering context url)"
              },
              "block_index": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "0-based index of the target block within its parent's blocks (the section root when `parent_path` is empty)"
              },
              "parent_path": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -2147483648,
                  "maximum": 2147483647
                },
                "maxItems": 10,
                "description": "Ancestor index path from the section root to the target block's parent (each element a 0-based index into a blocks array); empty = top-level. e.g. `parent_path=[1,0]` with `block_index=2` targets `section.blocks[1].blocks[0].blocks[2]`"
              },
              "props": {
                "type": "object",
                "additionalProperties": true,
                "description": "Key→value properties to set/merge into the block's settings"
              },
              "template_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Template name; defaults to file location without `.liquid`"
              },
              "locale": {
                "type": "string",
                "maxLength": 262144,
                "description": "Rendering locale; defaults to en_US"
              }
            },
            "required": [
              "doc_id",
              "theme_id",
              "props"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Set/merge properties into a specific block's settings within a card. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "section",
          "type": "object",
          "schema": "google.protobuf.Struct"
        },
        {
          "name": "html",
          "type": "string"
        }
      ]
    },
    "theme-gen-block-update": {
      "risk": "H",
      "module": "themes",
      "method": "PATCH",
      "path": "/themes/edit-sessions/{oseid}/gen-blocks",
      "description": "Update AI card",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              }
            },
            "required": [
              "oseid"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "content": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "New liquid source; must contain a schema tag"
              },
              "settings": {
                "type": "object",
                "additionalProperties": true,
                "description": "The card's full config, same shape as the create response's `settings`. Its `type` (blocks/gen_ prefixed) names the card to change; the field values are the merchant's current config"
              }
            },
            "required": [
              "content",
              "settings"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update an AI card with new source code and its full settings. If the card is unused or used in\nonly one place, it is changed in place (`branched=false`); if it is used in several places, a\nnew card is created to carry this change (`branched=true`), and you need to replace the card at\nthe target position with the returned `settings`. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "revert_id",
          "type": "string"
        },
        {
          "name": "branched",
          "type": "boolean"
        },
        {
          "name": "settings",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-delete": {
      "risk": "D",
      "module": "themes",
      "method": "DELETE",
      "path": "/themes/{theme_id}",
      "description": "Delete theme",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme's unique identifier"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Delete a specific theme using its unique identifier. The default theme cannot be deleted. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "theme-duplicate": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/copy",
      "description": "Duplicate theme",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "copy_theme_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Source theme id to copy from"
              },
              "copy_theme_name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Name for the new (copied) theme"
              },
              "sources": {
                "type": "string",
                "maxLength": 262144,
                "description": "Optional comma-separated source scopes to copy. Defaults to all"
              }
            },
            "required": [
              "copy_theme_id",
              "copy_theme_name"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Copy an existing theme within the current store into a new one and return the new theme ID;\n`sources` limits what is copied. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "data",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-doc-create": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/{theme_id}/doc",
      "description": "Create theme file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme's unique identifier"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "doc": {
                "$ref": "#/$defs/v202506.CreateThemeFileParam",
                "description": "The file to create, containing its type, location, and content"
              }
            },
            "required": [
              "doc"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Creates a new file within the specified theme. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateThemeFileParam": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "location": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "content": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "type",
              "location"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": []
    },
    "theme-doc-delete": {
      "risk": "D",
      "module": "themes",
      "method": "DELETE",
      "path": "/themes/{theme_id}/doc",
      "description": "Delete theme file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme's unique identifier"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "default": "assets",
                "description": "The type of file to delete: `layout`, `templates`, `sections`, `snippets`, `assets`, `config`, `locales`, `blocks`. Defaults to `assets`"
              },
              "location": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "default": "a.js",
                "description": "The location of the file within the theme. Always pass it explicitly: when omitted the request falls back to assets/a.js and deletes that file"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Delete a specific theme file by theme ID, file type, and file location. `assets/theme.css` and\n`layout/theme.layout` cannot be deleted. Deleting a card file that is still used on a page does\nnot fail; that card simply stops showing on the page. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "theme-doc-file": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/{theme_id}/doc",
      "description": "Get theme file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme's unique identifier"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The type of file to retrieve: `layout`, `templates`, `sections`, `snippets`, `assets`, `config`, `locales`, `blocks`. Defaults to `layout`"
              },
              "location": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "The file's location. Defaults to theme.liquid"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve details of a specific theme's doc file using its unique identifier Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "theme_file",
          "type": "object",
          "schema": "v202506.ThemeFile",
          "has_id": true
        }
      ]
    },
    "theme-doc-rename": {
      "risk": "H",
      "module": "themes",
      "method": "PUT",
      "path": "/themes/{theme_id}/doc-rename",
      "description": "Rename theme file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme's unique identifier"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "doc": {
                "$ref": "#/$defs/v202506.RenameThemeFileParam",
                "description": "The file to rename, containing its type and the current and new location"
              }
            },
            "required": [
              "doc"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Renames an existing file within the specified theme. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.RenameThemeFileParam": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "location": {
                "type": "string",
                "maxLength": 262144
              },
              "new_location": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "type"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": []
    },
    "theme-doc-tree": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/{theme_id}/doctree",
      "description": "Get theme file tree",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The unique ID of the theme for which the doc-tree is requested"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Get the file tree of the specified theme. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "layouts",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ThemeDocLocation"
          }
        },
        {
          "name": "templates",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ThemeDocLocation"
          }
        },
        {
          "name": "sections",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ThemeDocLocation"
          }
        },
        {
          "name": "snippets",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ThemeDocLocation"
          }
        },
        {
          "name": "assets",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ThemeDocLocation"
          }
        },
        {
          "name": "configs",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ThemeDocLocation"
          }
        },
        {
          "name": "locales",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ThemeDocLocation"
          }
        },
        {
          "name": "blocks",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ThemeDocLocation"
          }
        }
      ]
    },
    "theme-doc-patch": {
      "risk": "H",
      "module": "themes",
      "method": "PATCH",
      "path": "/themes/{theme_id}/doc",
      "description": "Update theme file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme's unique identifier"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "doc": {
                "$ref": "#/$defs/v202506.UpdateThemeFileParam",
                "description": "The file to update, containing its type, location, and new content"
              }
            },
            "required": [
              "doc"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Replace the whole content of the specified file. Changes to the default theme's files take\neffect on the storefront immediately; every change is recorded in the file's version history. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateThemeFileParam": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "location": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "content": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "type",
              "location",
              "content"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": []
    },
    "theme-detail": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/{theme_id}",
      "description": "Get theme info",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme's unique identifier"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieve details of a specific theme using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "theme",
          "type": "object",
          "schema": "v202506.Theme",
          "has_id": true
        }
      ]
    },
    "themes": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes",
      "description": "List themes",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "published": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter themes by published status: `0` for unpublished, `1` for published. Omit to return both. With `1` at most one theme (the published one) is returned and paging does not apply"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Cursor for pagination. Use the cursor returned in the previous response to retrieve the next page"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Number of themes to return per page. Range: 1-250. Default is 10"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "List of theme IDs to filter by. Only themes matching the given IDs are returned. Example: ?ids=1001&ids=1002"
              },
              "contain_ext_theme": {
                "type": "boolean",
                "description": "Whether to include extension themes in the returned results"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "List the store's themes; filter by `published` or `ids`. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "themes",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Theme"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "theme-install": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/merchant-themes/{remote_theme_id}/install",
      "description": "Install market theme",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "remote_theme_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Remote theme id of the market theme to install"
              }
            },
            "required": [
              "remote_theme_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme display name"
              },
              "default": {
                "type": "boolean",
                "description": "Set as the store default theme"
              },
              "preset": {
                "type": "string",
                "maxLength": 262144,
                "description": "Style/preset name (from the market theme's presets)"
              },
              "version": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme version to install; defaults to the market theme's current version (`c_version`)"
              },
              "sources": {
                "type": "string",
                "maxLength": 262144,
                "description": "Business source tag recorded on the installed theme. Unrelated to CopyThemeRequest.sources"
              },
              "admin_hidden": {
                "type": "boolean",
                "description": "Hide the installed theme in the merchant admin"
              },
              "ext_suffix": {
                "type": "string",
                "maxLength": 262144,
                "description": "Suffix appended to the extension theme's name; keep it to 15 characters or fewer"
              },
              "product_id_map": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": true
                },
                "maxItems": 10,
                "description": "Product id mappings"
              },
              "collection_id_map": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": true
                },
                "maxItems": 10,
                "description": "Collection id mappings"
              },
              "page_id_map": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": true
                },
                "maxItems": 10,
                "description": "Custom page id mappings"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Install a theme from the theme market into the current store by its market theme id. Supports\nspecifying the theme name and style preset, and setting it as the store's default theme; if the\nstore has no default theme yet, the installed theme becomes the default automatically. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "data",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-market": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/merchant-themes",
      "description": "List market themes",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "price": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by price band, comma-separated; values come from `MerchantTheme.price`"
              },
              "preset_default": {
                "type": "string",
                "maxLength": 262144,
                "description": "Preset-default filter: `1` returns only preset-default themes. Omit to return all"
              },
              "industry": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by industry, comma-separated"
              },
              "language": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by language, comma-separated"
              },
              "category": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by category, comma-separated; values come from `MerchantTheme.category`"
              },
              "features": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter by features, comma-separated"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number, starts at 1. Omit or pass 0 to use the default (1)"
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Page size, up to 200. Omit or pass 0 to use the default (200)"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Retrieve the installable platform themes in the theme market. Supports filtering by price\nband, industry, language, category, and features. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "merchant_themes",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.MerchantTheme"
          }
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "total_pages",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "current_page",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "limit",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "theme-pb-template-delete": {
      "risk": "D",
      "module": "themes",
      "method": "DELETE",
      "path": "/themes/page-builder/custom-templates/{template_id}",
      "description": "Delete page-builder custom template",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "template_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Template id to delete"
              }
            },
            "required": [
              "template_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Delete a page-builder custom template by id. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "data",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-pb-single-blocks": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/page-builder/blocks",
      "description": "Get page-builder block details",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "event_type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Event type of the blocks to look up; use `page-builder` for page-builder blocks"
              },
              "source_ids": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Source IDs, comma-separated, e.g. `\"global-654263218792825795\"`"
              }
            },
            "required": [
              "event_type",
              "source_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false,
        "description": "Batch-fetch page-builder blocks by `source_ids`: each returns its name, full block `type`, and\ndefault `settings` — what you need to place the card on a page. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "blocks",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-pb-block-save": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/page-builder/blocks",
      "description": "Save page-builder block",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "event_type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Event type of the card. With `theme`, the response also carries `type` and `block`; other event types only save the card and do not create the single-page block"
              },
              "origin_template_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Source template ID the new card derives from. The new card's own id is returned in the response"
              },
              "title": {
                "type": "object",
                "additionalProperties": true,
                "description": "Block title as an i18n map, e.g. `{\"en-US\": \"...\", \"zh-CN\": \"...\"}`"
              },
              "action": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Save action: `save`, `save_as`, `update`"
              },
              "category": {
                "type": "string",
                "maxLength": 262144,
                "description": "Category, e.g. `image_with_text`"
              },
              "second_category": {
                "type": "string",
                "maxLength": 262144,
                "description": "Second category, e.g. `Carousal`"
              },
              "image": {
                "type": "string",
                "maxLength": 262144,
                "description": "Preview image filename"
              },
              "origin": {
                "type": "string",
                "maxLength": 262144,
                "description": "Base template scope: `custom` or `global`. Empty looks up `custom` first, then `global`"
              },
              "ops": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": true
                },
                "maxItems": 10,
                "description": "Operations applied to the base template before saving. At least one op is required; an empty list is rejected with 400"
              },
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID to insert the new card into"
              },
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document (template file) ID for the session insert"
              },
              "section_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Target section ID whose content is replaced with the new card"
              },
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID for the render context url of the session insert"
              },
              "template_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Template name for the session insert; defaults to file location without `.liquid`"
              },
              "locale": {
                "type": "string",
                "maxLength": 262144,
                "description": "Rendering locale for the session insert; defaults to en_US"
              }
            },
            "required": [
              "event_type",
              "origin_template_id",
              "action",
              "oseid",
              "doc_id",
              "section_id",
              "theme_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Apply edit operations (`ops`) to a page-builder template and save the result as a new card,\nthen place it at the target position in the edit session; when `event_type` is not `theme`, the\ncard is only saved and not placed on the page. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "series_id",
          "type": "string"
        },
        {
          "name": "show_templates",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "block",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-pb-template-save": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/page-builder/custom-templates",
      "description": "Save page-builder custom template",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "action": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Action. All three create a new template; they differ in whether it is listed: - `save_as`: A new copy, listed - `update`: A new listed version; the template given by `template_id` is taken down - `save`: Saved but not shown in the template list"
              },
              "template_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Source template id for `save_as` / the template to version up for `update`"
              },
              "title": {
                "type": "object",
                "additionalProperties": true,
                "description": "Template title (i18n map). Optional; defaults to the source template's title"
              },
              "category": {
                "type": "string",
                "maxLength": 262144,
                "description": "First-level category. Optional; defaults to source"
              },
              "second_category": {
                "type": "string",
                "maxLength": 262144,
                "description": "Second-level category. Optional; defaults to source"
              },
              "image": {
                "type": "string",
                "maxLength": 262144,
                "description": "Preview image filename. Optional; defaults to source"
              },
              "origin": {
                "type": "string",
                "maxLength": 262144,
                "description": "Origin type: `custom`, `global`. Optional; defaults to source"
              }
            },
            "required": [
              "action",
              "template_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Save a custom card template based on an existing template; `action` decides how it is saved.\nAll three actions produce a new template id, and `update` takes the original template down. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "series_id",
          "type": "string"
        },
        {
          "name": "show_templates",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "theme-pb-summary": {
      "risk": "R",
      "module": "themes",
      "method": "POST",
      "path": "/themes/page-builder/summary",
      "description": "Render template canvas snapshot",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "schema": {
                "type": "object",
                "additionalProperties": true,
                "description": "Full canvas data (page-builder ProjectData); either `schema` or `id` (prefer `id`)"
              },
              "detail_level": {
                "type": "string",
                "maxLength": 262144,
                "description": "Detail level: `minimal`, `tiered`, `verbose`. Defaults to `minimal`"
              },
              "detailed_node_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Node paths to expand details for, e.g. `0.1.2`"
              },
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Template id to summarize; the server loads its canvas data. Either `id` or `schema` — prefer `id` so the full canvas data stays out of the request"
              },
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Template type when fetching by id: `custom` (default, custom card templates), `global` (public templates). Only honored with id; any other value is rejected. Same values as `origin` when saving a page-builder block"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Pass a template id or full canvas data, and get back a text snapshot of the canvas; each node\ncarries a `#path` number that can be used to target it in edit operations. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "text",
          "type": "string"
        },
        {
          "name": "timings",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-pb-update": {
      "risk": "R",
      "module": "themes",
      "method": "POST",
      "path": "/themes/page-builder/update",
      "description": "Preview page-builder canvas edits",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "schema": {
                "type": "object",
                "additionalProperties": true,
                "description": "Full canvas data (page-builder ProjectData)"
              },
              "ops": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": true
                },
                "maxItems": 100,
                "description": "Operations to apply; defaults to re-export"
              }
            },
            "required": [
              "schema"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Apply edit operations (`ops`) to the given canvas data and return the edited canvas data, the\nrendered HTML, the canvas text snapshot, and translations. Nothing is saved. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "schema",
          "type": "object",
          "schema": "google.protobuf.Struct"
        },
        {
          "name": "text",
          "type": "string"
        },
        {
          "name": "html",
          "type": "string"
        },
        {
          "name": "translation",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "google.protobuf.Struct"
          }
        },
        {
          "name": "failures",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "google.protobuf.Struct"
          }
        },
        {
          "name": "timings",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-publish": {
      "risk": "H",
      "module": "themes",
      "method": "PATCH",
      "path": "/themes/{theme_id}/publish",
      "description": "Publish theme",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme's unique identifier"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Publish a specific theme using its unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "theme",
          "type": "object",
          "schema": "v202506.PublishThemeData",
          "has_id": true
        }
      ]
    },
    "theme-rename": {
      "risk": "H",
      "module": "themes",
      "method": "PATCH",
      "path": "/themes/{theme_id}/name",
      "description": "Rename theme",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme id (uuid) to rename"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "New theme name"
              }
            },
            "required": [
              "name"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Change the display name of a theme in the current store. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "data",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-cards-list": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/cards",
      "description": "List addable cards",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID. Optional; only used by the `theme` source. Empty -> the theme source returns empty"
              },
              "source": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100,
                "description": "Data source filter. Multi-value (repeat the param `source=pb&source=public`, or comma-join `source=pb,public`); empty aggregates every source: - `theme`: cards bundled with the theme - `pb`: page-builder cards from public templates - `custom`: page-builder cards from the merchant's custom card templates - `extension`: app extension cards - `public`: public cards - `gen`: AI cards"
              },
              "category": {
                "type": "string",
                "maxLength": 262144,
                "description": "Primary category filter. Only applies to the pb source"
              },
              "second_category": {
                "type": "string",
                "maxLength": 262144,
                "description": "Secondary category filter. Only applies to the pb source"
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Page size, defaults to 10, range 1-100"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number"
              },
              "template": {
                "type": "string",
                "maxLength": 262144,
                "description": "Template filter. Template name (`index`, `product`, `collection`, `cart`, `page`, `search`, or a custom template name)"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "List all addable cards under the current theme across sources (`theme`, `pb`, `custom`,\n`extension`, `public`, `gen`), de-duplicated, ordered by source, and paginated. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.Card"
          }
        },
        {
          "name": "total",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "page",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "limit",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "theme-section-card-detail": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/edit-sessions/{oseid}/files/{doc_id}/sections/{section_id}",
      "description": "Get card details",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document (template file) ID"
              },
              "section_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Section (card) ID to render"
              }
            },
            "required": [
              "oseid",
              "doc_id",
              "section_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "template_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Optional current page template name; scopes supported data source types"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Render the specified card with its current config and return the rendered HTML, the card\nconfig, and its configuration definitions, without changing any data. Global cards such as the\nheader and footer are also supported. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "data",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-section-cards-list": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/edit-sessions/{oseid}/files/{doc_id}/sections",
      "description": "List cards added to a template",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document (template file) ID"
              }
            },
            "required": [
              "oseid",
              "doc_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "template_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Optional current page template name; scopes supported data source types"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "List all cards added to a template within an edit session, including global card groups such\nas the header and footer. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "data",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-section-remove": {
      "risk": "D",
      "module": "themes",
      "method": "DELETE",
      "path": "/themes/edit-sessions/{oseid}/sections/{section_id}",
      "description": "Remove card from page",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "section_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Section instance ID to remove. Page-flow mode (`area` omitted) requires the numeric instance id from `content_for_page`; with `area` set, pass the area member's stored id"
              }
            },
            "required": [
              "oseid",
              "section_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document (template file) ID"
              },
              "area": {
                "type": "string",
                "maxLength": 262144,
                "description": "Target area: omit = the page flow; `header`, `footer` = remove from the header/footer area group (section-group themes only)"
              }
            },
            "required": [
              "doc_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Remove a card from the page within an edit session. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "content_for_page",
          "type": "array",
          "items": {
            "type": "integer",
            "format": "int64"
          }
        }
      ]
    },
    "theme-section-set-props": {
      "risk": "H",
      "module": "themes",
      "method": "PATCH",
      "path": "/themes/edit-sessions/{oseid}/sections/{section_id}/props",
      "description": "Set card properties",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "section_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Section instance ID inside the document; a global card id (`header`, `footer`, `announcement`, `cart_drawer`) also works"
              }
            },
            "required": [
              "oseid",
              "section_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document (template file) ID the section lives in"
              },
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID (used to build the rendering context url)"
              },
              "props": {
                "type": "object",
                "additionalProperties": true,
                "description": "Key→value properties to set/merge into the section's settings"
              },
              "template_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Template name, e.g. index. Defaults to the file location without `.liquid`"
              },
              "locale": {
                "type": "string",
                "maxLength": 262144,
                "description": "Rendering locale; defaults to en_US"
              }
            },
            "required": [
              "doc_id",
              "theme_id",
              "props"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Set/merge properties into a card's settings within an edit session. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "section",
          "type": "object",
          "schema": "google.protobuf.Struct"
        },
        {
          "name": "html",
          "type": "string"
        }
      ]
    },
    "theme-edit-session-batch-operations": {
      "risk": "D",
      "module": "themes",
      "method": "POST",
      "path": "/themes/edit-sessions/{oseid}/files/{doc_id}/operations",
      "description": "Batch edit operations",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document ID of the file within the session"
              }
            },
            "required": [
              "oseid",
              "doc_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "operations": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.ThemeOperation"
                },
                "maxItems": 10,
                "minItems": 1,
                "description": "Ordered list of theme operations executed in one batch. Each op is applied and persisted independently, and a failure on one does not stop the others. See `ThemeOperation`."
              }
            },
            "required": [
              "operations"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Execute multiple edit operations in one request; each operation runs and is saved\nindependently, and a failure on one does not stop the others. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.ThemeOperation": {
            "type": "object",
            "properties": {
              "op": {
                "type": "string",
                "maxLength": 262144
              },
              "target": {
                "type": "string",
                "maxLength": 262144
              },
              "value": {},
              "props": {
                "type": "object",
                "additionalProperties": true
              },
              "visible": {
                "type": "boolean"
              },
              "position": {
                "type": "string",
                "maxLength": 262144
              },
              "move_target": {
                "type": "string",
                "maxLength": 262144
              },
              "section_id": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "op"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "data",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.ThemeOperationResult"
          }
        }
      ]
    },
    "theme-edit-session-card-list": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/edit-sessions/{oseid}/card-list",
      "description": "List edit-session card library",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              }
            },
            "required": [
              "oseid"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "need_schema": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Pass 1 to additionally return `schema` and `settings` on section cards"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "List the cards available in the theme: regular cards (`card_list`, `block_list`) come from the\npublished version; AI cards are listed separately in `gen_list`, including ones created in this\nsession that are not yet placed or saved, each carrying `saved` to indicate whether it has been\nsaved to the draft. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "card_list",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.CardGroup"
          }
        },
        {
          "name": "block_list",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.CardGroup"
          }
        },
        {
          "name": "gen_list",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.CardGroup"
          }
        }
      ]
    },
    "theme-edit-session-conflict": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/edit-sessions/{oseid}/conflict",
      "description": "Check edit session conflict",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              }
            },
            "required": [
              "oseid"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Check whether the draft has been changed by another session since this edit session started. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "conflict",
          "type": "boolean"
        }
      ]
    },
    "theme-edit-session-create": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/{theme_id}/edit-sessions",
      "description": "Create theme edit session",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID to open an edit session for"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Open a temporary edit session (oseid) for the specified theme. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "oseid",
          "type": "string"
        }
      ]
    },
    "theme-global-config": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/edit-sessions/{oseid}/files/{doc_id}/global",
      "description": "Get theme global config",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document (template file) ID"
              }
            },
            "required": [
              "oseid",
              "doc_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Optional case-insensitive primary-category name filter; empty = all"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Get the current values of the theme settings within an edit session, plus the configuration\ndefinitions of each primary category. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "data",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-edit-session-file-get": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/edit-sessions/{oseid}/files/{doc_id}",
      "description": "Get edit session file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document ID of the file within the session"
              }
            },
            "required": [
              "oseid",
              "doc_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Read a single file within a theme edit session. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "template",
          "type": "object",
          "schema": "v202601.EditSessionFile",
          "has_id": true
        }
      ]
    },
    "theme-edit-session-promote": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/edit-sessions/{oseid}/promote",
      "description": "Save edit session as draft",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              }
            },
            "required": [
              "oseid"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "force": {
                "type": "boolean",
                "description": "Force overwrite even if there is a conflict"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Save an edit session as the draft. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "promoted",
          "type": "boolean"
        },
        {
          "name": "conflict",
          "type": "boolean"
        }
      ]
    },
    "theme-global-config-update": {
      "risk": "H",
      "module": "themes",
      "method": "PATCH",
      "path": "/themes/edit-sessions/{oseid}/files/{doc_id}/global",
      "description": "Update theme global config",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document (template file) ID"
              }
            },
            "required": [
              "oseid",
              "doc_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "settings": {
                "type": "object",
                "additionalProperties": true,
                "description": "Settings to change — partial, one or many key/value pairs; other settings stay untouched"
              },
              "section_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Target: omit or `skin` = global variables; otherwise a global section's type or stored id — the global singletons (`header`, `footer`, `announcement`, `cart_drawer`) or any member of the header / footer regions. An id that is not in the session returns 400"
              },
              "template_name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Render-context template name, default `index`"
              },
              "locale": {
                "type": "string",
                "maxLength": 262144,
                "description": "Render locale, default `en_US`"
              }
            },
            "required": [
              "settings"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Partially update the theme's global config within an edit session: pass only the settings to\nchange (one or many). Updates the theme settings by default; pass `section_id` to update a\nglobal card such as the header, footer, announcement bar, or cart drawer. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "section",
          "type": "object",
          "schema": "google.protobuf.Struct"
        },
        {
          "name": "html",
          "type": "string"
        }
      ]
    },
    "theme-edit-session-file-update": {
      "risk": "D",
      "module": "themes",
      "method": "PATCH",
      "path": "/themes/edit-sessions/{oseid}/files/{doc_id}",
      "description": "Update edit session file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Edit session ID"
              },
              "doc_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Document ID of the file within the session"
              }
            },
            "required": [
              "oseid",
              "doc_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "config": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/v202601.EditSessionConfigItem"
                },
                "maxItems": 10,
                "description": "The file's complete, ordered list of section configs. This is a whole-file write: the list REPLACES the file's current sections and any section omitted here is removed. Array order is the on-page render order. For incremental edits use the batch-operations endpoint"
              },
              "global_config": {
                "$ref": "#/$defs/v202601.EditSessionGlobalConfig",
                "description": "Global config"
              },
              "layout": {
                "type": "string",
                "maxLength": 262144,
                "description": "Layout name, e.g. theme"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Overwrite a template file in the edit session with the given card configs; cards missing from\nthe list are removed. For partial changes, use Batch edit operations. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.EditSessionConfigItem": {
            "type": "object",
            "properties": {
              "id": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "string",
                    "pattern": "^-?(0|[1-9][0-9]{0,18})$",
                    "maxLength": 20
                  }
                ],
                "x-integer-format": "int64"
              },
              "settings": {
                "type": "object",
                "additionalProperties": true
              },
              "with_hook_set": {
                "type": "boolean"
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "v202601.EditSessionGlobalConfig": {
            "type": "object",
            "properties": {
              "libs": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "template_data",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "theme-task": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/task/{task_id}",
      "description": "Get theme task",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "task_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Task ID"
              }
            },
            "required": [
              "task_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Get the status and details of a theme background task, such as a theme upload or upgrade. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "task",
          "type": "object",
          "schema": "v202506.Task",
          "has_id": true
        }
      ]
    },
    "theme-templates-create": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/{theme_id}/theme-templates",
      "description": "Create theme custom template",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID this template belongs to"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Template type. One of `product`, `collection`, `product_coll`, `page`"
              },
              "title": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Template display name"
              },
              "relations": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "description": "Bound object IDs (products / collections). Empty = create without binding"
              },
              "from": {
                "type": "string",
                "maxLength": 262144,
                "description": "Source template suffix to copy from, e.g. default"
              },
              "oseid": {
                "type": "string",
                "maxLength": 262144,
                "description": "Edit session ID the creation is performed within"
              },
              "selected_all": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Bind every object matching `front_query_params` instead of listing them in `relations`: 0 = no (default), 1 = yes. When 1, the object set comes from `front_query_params`"
              },
              "front_query_params": {
                "$ref": "#/$defs/v202601.CreateThemeTemplateFrontQueryParams",
                "description": "Filter that defines the object set when `selected_all` = 1; ignored otherwise"
              }
            },
            "required": [
              "type",
              "title"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a custom template and bind it to objects (products, collections) in one call; with empty\n`relations` the template is created without bindings. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.CreateThemeTemplateFrontQueryParams": {
            "type": "object",
            "properties": {
              "search_keyword": {
                "type": "string",
                "maxLength": 262144
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "theme_template",
          "type": "object",
          "schema": "v202601.ThemeTemplate",
          "has_id": true
        }
      ]
    },
    "theme-templates-delete": {
      "risk": "D",
      "module": "themes",
      "method": "DELETE",
      "path": "/themes/{theme_id}/theme-templates/{template_id}",
      "description": "Delete theme custom template",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID this template belongs to"
              },
              "template_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Template ID to delete"
              }
            },
            "required": [
              "theme_id",
              "template_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Delete a custom template within the specified theme. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "theme-templates-list": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/{theme_id}/theme-templates",
      "description": "List theme custom templates",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "description": "Optional filter by template type: `product`, `collection`, `product_coll`, `page`. Empty returns all types"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Optional page number for pagination (default: 1)"
              },
              "per_page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Optional page size for pagination (default: 100)"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "List the custom templates bound to products, collections, or custom pages. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "theme_templates",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.ThemeTemplate"
          }
        }
      ]
    },
    "theme-templates-update": {
      "risk": "H",
      "module": "themes",
      "method": "PATCH",
      "path": "/themes/{theme_id}/theme-templates/{template_id}",
      "description": "Update theme custom template",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme ID this template belongs to"
              },
              "template_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Theme template ID to update"
              }
            },
            "required": [
              "theme_id",
              "template_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Template type. One of `product`, `collection`, `product_coll`, `page`"
              },
              "relations": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10,
                "description": "The template's full binding list (product / collection IDs). It REPLACES the current bindings rather than being merged into them. An empty array — or omitting the field entirely — unbinds everything, so always resend the full list when you only mean to keep it"
              },
              "selected_all": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Bind every object matching `front_query_params` instead of listing them in `relations`: 0 = no (default), 1 = yes. When 1, the object set comes from `front_query_params`"
              },
              "front_query_params": {
                "$ref": "#/$defs/v202601.UpdateThemeTemplateFrontQueryParams",
                "description": "Filter that defines the object set when `selected_all` = 1; ignored otherwise"
              }
            },
            "required": [
              "type"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update the bindings (products, collections) of an existing template. `relations` replaces the\ncurrent bindings as a whole; an empty array or omitting it removes all bindings. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202601.UpdateThemeTemplateFrontQueryParams": {
            "type": "object",
            "properties": {
              "search_keyword": {
                "type": "string",
                "maxLength": 262144
              },
              "collection_id": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": []
    },
    "theme-upgrade": {
      "risk": "H",
      "module": "themes",
      "method": "POST",
      "path": "/themes/{theme_id}/upgrade",
      "description": "Upgrade theme",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "The ID of the theme to upgrade"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 262144,
                "description": "Optional new name for the upgraded theme. Leave empty to keep the current name"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Create a new theme upgraded to the latest version from the specified theme, carrying over its\nconfiguration; the original theme is left unchanged. Returns the new theme ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "theme_id",
          "type": "string"
        }
      ]
    },
    "theme-doc-version-detail": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/{theme_id}/doc/versions/{version_id}",
      "description": "Get theme file version",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme's unique identifier"
              },
              "version_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Version's unique identifier"
              }
            },
            "required": [
              "theme_id",
              "version_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Retrieves a specific version of a theme file by its version ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "version",
          "type": "object",
          "schema": "v202506.ThemeFileVersion",
          "has_id": true
        }
      ]
    },
    "theme-doc-versions": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/{theme_id}/doc/versions",
      "description": "List versions of a theme file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme's unique identifier"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "default": "layout",
                "description": "The type of file to list versions for: `layout`, `templates`, `sections`, `snippets`, `assets`, `config`, `locales` (`blocks` is not supported here). Defaults to `layout`"
              },
              "location": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "default": "theme.liquid",
                "description": "The location of the file within the theme. Defaults to theme.liquid"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Returns the version history for a single theme file. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "versions",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ThemeFileVersion"
          }
        }
      ]
    },
    "theme-doc-version": {
      "risk": "R",
      "module": "themes",
      "method": "GET",
      "path": "/themes/{theme_id}/doc/version-records",
      "description": "List versions of all theme files",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "theme_id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Theme's unique identifier"
              }
            },
            "required": [
              "theme_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Returns the version history for all files in the specified theme. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "versions",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ThemeFileVersion"
          }
        }
      ]
    },
    "carrier-service-create": {
      "risk": "H",
      "module": "shop",
      "method": "POST",
      "path": "/carrier_services",
      "description": "Create carrier service",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "carrier_service": {
                "$ref": "#/$defs/v202506.CreateCarrierServiceParam",
                "description": "Carrier service data to create"
              }
            },
            "required": [
              "carrier_service"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Enables users to create a new carrier service for calculating shipping rates. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateCarrierServiceParam": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "callback_url": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "carrier_code": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "active": {
                "type": "boolean"
              },
              "logo": {
                "type": "string",
                "maxLength": 262144
              },
              "short_desc": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "required": [
              "name",
              "callback_url",
              "carrier_code"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "carrier_service",
          "type": "object",
          "schema": "v202506.CarrierService",
          "has_id": true
        }
      ]
    },
    "carrier-service-delete": {
      "risk": "D",
      "module": "shop",
      "method": "DELETE",
      "path": "/carrier_services/{carrier_service_id}",
      "description": "Delete carrier service",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "carrier_service_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Carrier service ID to delete"
              }
            },
            "required": [
              "carrier_service_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Allows users to remove an existing carrier service. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "carrier-service-detail": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/carrier_services/{carrier_service_id}",
      "description": "Get carrier service",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "carrier_service_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Carrier service ID to query"
              }
            },
            "required": [
              "carrier_service_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false,
        "description": "Allows users to retrieve detailed information about a specific carrier service by its unique ID. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "carrier_service",
          "type": "object",
          "schema": "v202506.CarrierService",
          "has_id": true
        }
      ]
    },
    "carrier-services": {
      "risk": "R",
      "module": "shop",
      "method": "GET",
      "path": "/carrier_services",
      "description": "List carrier services",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Retrieves a list of all carrier services available for a store. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "carrier_services",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.CarrierService"
          }
        }
      ]
    },
    "carrier-service-update": {
      "risk": "H",
      "module": "shop",
      "method": "PUT",
      "path": "/carrier_services/{carrier_service_id}",
      "description": "Update carrier service",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "carrier_service_id": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1,
                "description": "Carrier service ID to update"
              }
            },
            "required": [
              "carrier_service_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "carrier_service": {
                "$ref": "#/$defs/v202506.UpdateCarrierServiceParam",
                "description": "Carrier service data to update"
              }
            },
            "required": [
              "carrier_service"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Allows users to update the details of an existing carrier service. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateCarrierServiceParam": {
            "type": "object",
            "properties": {
              "callback_url": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "active": {
                "type": "boolean"
              }
            },
            "required": [
              "callback_url",
              "active"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "carrier_service",
          "type": "object",
          "schema": "v202506.CarrierService",
          "has_id": true
        }
      ]
    },
    "webhook-count": {
      "risk": "R",
      "module": "webhook",
      "method": "GET",
      "path": "/webhooks/count",
      "description": "Count webhooks",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "address": {
                "type": "string",
                "maxLength": 262144,
                "description": "Webhook notification URL, e.g. https://example.com/webhook"
              },
              "topic": {
                "type": "string",
                "maxLength": 262144,
                "description": "The event name, e.g. orders/cancelled,orders/create"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Count webhooks with a unique identifier, notification URL, event name, and format. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "webhook-create": {
      "risk": "H",
      "module": "webhook",
      "method": "POST",
      "path": "/webhooks",
      "description": "Create a webhook",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "webhook": {
                "$ref": "#/$defs/v202506.CreateWebhookParam",
                "description": "Webhook"
              }
            },
            "required": [
              "webhook"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false,
        "description": "Create a webhook with a unique identifier, notification URL, event name, and format. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.CreateWebhookParam": {
            "type": "object",
            "properties": {
              "address": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "topic": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "address",
              "topic"
            ],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "webhook",
          "type": "object",
          "schema": "v202506.WebhookParam",
          "has_id": true
        }
      ]
    },
    "webhook-delete": {
      "risk": "D",
      "module": "webhook",
      "method": "DELETE",
      "path": "/webhooks/{id}",
      "description": "Delete a webhook",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Webhook ID"
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
        "additionalProperties": false,
        "description": "Delete a webhook with a unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": []
    },
    "webhook-detail": {
      "risk": "R",
      "module": "webhook",
      "method": "GET",
      "path": "/webhooks/{id}",
      "description": "Get a webhook",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Webhook ID"
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
        "additionalProperties": false,
        "description": "Get a webhook with a unique identifier. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "webhook",
          "type": "object",
          "schema": "v202506.WebhookParam",
          "has_id": true
        }
      ]
    },
    "webhooks": {
      "risk": "R",
      "module": "webhook",
      "method": "GET",
      "path": "/webhooks",
      "description": "List webhooks",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "address": {
                "type": "string",
                "maxLength": 262144,
                "description": "Webhook notification URL, e.g. https://example.com/webhook"
              },
              "topic": {
                "type": "string",
                "maxLength": 262144,
                "description": "The event name, e.g. orders/cancelled,orders/create"
              },
              "created_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter webhook records created at after date, e.g. 2018-08-26T06:19:53Z"
              },
              "created_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter webhook records created at before date, e.g. 2018-08-26T06:19:53Z"
              },
              "updated_at_min": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter webhook records updated at after date, e.g. 2018-08-26T06:19:53Z"
              },
              "updated_at_max": {
                "type": "string",
                "maxLength": 262144,
                "description": "Filter webhook records updated at before date, e.g. 2018-08-26T06:19:53Z"
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Number of records to retrieve"
              },
              "page": {
                "type": "integer",
                "minimum": -2147483648,
                "maximum": 2147483647,
                "description": "Page number (1-based). Mutually exclusive with cursor"
              },
              "cursor": {
                "type": "string",
                "maxLength": 262144,
                "description": "Page cursor, used to retrieve the next page of records"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "List webhooks with a unique identifier, notification URL, event name, and format. Requires the corresponding merchant app permission."
      },
      "response_fields": [
        {
          "name": "webhooks",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.WebhookParam"
          }
        },
        {
          "name": "cursor",
          "type": "string"
        },
        {
          "name": "has_more",
          "type": "boolean"
        }
      ]
    },
    "webhook-update": {
      "risk": "H",
      "module": "webhook",
      "method": "PUT",
      "path": "/webhooks/{id}",
      "description": "Update a webhook",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 262144,
                "description": "Webhook ID"
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
              "webhook": {
                "$ref": "#/$defs/v202506.UpdateWebhookParam",
                "description": "Webhook"
              }
            },
            "required": [
              "webhook"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false,
        "description": "Update a webhook with a unique identifier, notification URL, event name, and format. Requires the corresponding merchant app permission.",
        "$defs": {
          "v202506.UpdateWebhookParam": {
            "type": "object",
            "properties": {
              "address": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              },
              "topic": {
                "type": "string",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [],
            "additionalProperties": false
          }
        }
      },
      "response_fields": [
        {
          "name": "webhook",
          "type": "object",
          "schema": "v202506.WebhookParam",
          "has_id": true
        }
      ]
    }
  },
  "response_schemas": {
    "v202506.CustomerAddress": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "customer_id",
          "type": "string"
        },
        {
          "name": "first_name",
          "type": "string"
        },
        {
          "name": "last_name",
          "type": "string"
        },
        {
          "name": "company",
          "type": "string"
        },
        {
          "name": "city",
          "type": "string"
        },
        {
          "name": "province",
          "type": "string"
        },
        {
          "name": "country",
          "type": "string"
        },
        {
          "name": "zip",
          "type": "string"
        },
        {
          "name": "province_code",
          "type": "string"
        },
        {
          "name": "country_code",
          "type": "string"
        },
        {
          "name": "gender",
          "type": "string"
        },
        {
          "name": "phone",
          "type": "string"
        },
        {
          "name": "phone_area_code",
          "type": "string"
        },
        {
          "name": "area",
          "type": "string"
        },
        {
          "name": "email",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "address1",
          "type": "string"
        },
        {
          "name": "address2",
          "type": "string"
        },
        {
          "name": "country_name",
          "type": "string"
        },
        {
          "name": "default",
          "type": "boolean"
        }
      ]
    },
    "v202506.Customer": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "email",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "first_name",
          "type": "string"
        },
        {
          "name": "last_name",
          "type": "string"
        },
        {
          "name": "phone",
          "type": "string"
        },
        {
          "name": "tags",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "phone_area_code",
          "type": "string"
        },
        {
          "name": "contact_type",
          "type": "string"
        },
        {
          "name": "sms_subscribed_flag",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "addresses",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.CustomerAddress"
          }
        },
        {
          "name": "accepts_marketing",
          "type": "boolean"
        },
        {
          "name": "source",
          "type": "string"
        },
        {
          "name": "free_tax",
          "type": "boolean"
        },
        {
          "name": "registered",
          "type": "boolean"
        },
        {
          "name": "orders_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "first_order_at",
          "type": "string"
        },
        {
          "name": "last_order_at",
          "type": "string"
        },
        {
          "name": "total_spent",
          "type": "string"
        },
        {
          "name": "subscribed_flag",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "accepts_sms_marketing",
          "type": "boolean"
        }
      ]
    },
    "v202601.response.Coupon": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "remarks",
          "type": "string"
        },
        {
          "name": "life_cycle_type",
          "type": "string"
        },
        {
          "name": "starts_at",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "ends_at",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "use_coupon_starts_at",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "use_coupon_ends_at",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "survival_time",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "discount_type",
          "type": "string"
        },
        {
          "name": "value",
          "type": "string"
        },
        {
          "name": "value_type",
          "type": "string"
        },
        {
          "name": "unlimited_usage",
          "type": "boolean"
        },
        {
          "name": "stock",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "once_per_customer",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "user_with_other",
          "type": "boolean"
        },
        {
          "name": "prerequisite_subtotal_range",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.response.CouponThresholdRange"
          }
        },
        {
          "name": "prerequisite_quantity_range",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.response.CouponThresholdRange"
          }
        },
        {
          "name": "entitled_product_ids",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "entitled_collection_ids",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "prerequisite_customer_segment_ids",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "prerequisite_customer_ids",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "sort",
          "type": "object",
          "schema": "v202601.response.Sort"
        },
        {
          "name": "config",
          "type": "object",
          "schema": "v202601.response.CouponConfig"
        }
      ]
    },
    "v202601.response.CouponThresholdRange": {
      "fields": [
        {
          "name": "greater_than_or_equal_to",
          "type": "string"
        },
        {
          "name": "value",
          "type": "string"
        }
      ]
    },
    "v202601.response.Sort": {
      "fields": [
        {
          "name": "by",
          "type": "string"
        },
        {
          "name": "direction",
          "type": "string"
        }
      ]
    },
    "v202601.response.CouponConfig": {
      "fields": [
        {
          "name": "banner_url",
          "type": "string"
        },
        {
          "name": "count_down",
          "type": "object",
          "schema": "v202601.response.CountDown"
        }
      ]
    },
    "v202601.response.CountDown": {
      "fields": [
        {
          "name": "background_color_end",
          "type": "string"
        },
        {
          "name": "background_color_start",
          "type": "string"
        },
        {
          "name": "color",
          "type": "string"
        },
        {
          "name": "count_down_background_color",
          "type": "string"
        },
        {
          "name": "count_down_color",
          "type": "string"
        },
        {
          "name": "detail_page_show_code",
          "type": "boolean"
        },
        {
          "name": "show_count_down",
          "type": "boolean"
        }
      ]
    },
    "v202601.response.DiscountDetail": {
      "fields": [
        {
          "name": "discount_info",
          "type": "object",
          "schema": "v202601.response.DiscountInfoResp"
        },
        {
          "name": "entitled_customer",
          "type": "object",
          "schema": "v202601.response.DiscountEntitledCustomerResp"
        },
        {
          "name": "entitled_product",
          "type": "object",
          "schema": "v202601.response.DiscountEntitledProductResp"
        },
        {
          "name": "obtain_product",
          "type": "object",
          "schema": "v202601.response.DiscountEntitledProductResp"
        },
        {
          "name": "discount_rule",
          "type": "object",
          "schema": "v202601.response.DiscountRuleResp"
        },
        {
          "name": "discount_layer",
          "type": "object",
          "schema": "v202601.response.DiscountLayerResp"
        },
        {
          "name": "discount_combine",
          "type": "object",
          "schema": "v202601.response.DiscountCombineResp"
        },
        {
          "name": "entitled_area",
          "type": "object",
          "schema": "v202601.response.DiscountEntitledAreaResp"
        }
      ]
    },
    "v202601.response.DiscountInfoResp": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "discount_name",
          "type": "string"
        },
        {
          "name": "display_name",
          "type": "string"
        },
        {
          "name": "discount_target",
          "type": "string"
        },
        {
          "name": "category",
          "type": "string"
        },
        {
          "name": "discount_type",
          "type": "string"
        },
        {
          "name": "discount_method",
          "type": "string"
        },
        {
          "name": "discount_code",
          "type": "string"
        },
        {
          "name": "discount_codes",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "starts_date",
          "type": "string"
        },
        {
          "name": "ends_date",
          "type": "string"
        },
        {
          "name": "starts_at",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "ends_at",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "is_old_discount",
          "type": "boolean"
        },
        {
          "name": "progress",
          "type": "string"
        },
        {
          "name": "enable_all_customer",
          "type": "boolean"
        },
        {
          "name": "is_show_admin",
          "type": "string"
        },
        {
          "name": "time_used",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202601.response.DiscountEntitledCustomerResp": {
      "fields": [
        {
          "name": "customer_ids",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "customer_segment_ids",
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ]
    },
    "v202601.response.DiscountEntitledProductResp": {
      "fields": [
        {
          "name": "product_ids",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "variant_ids",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "collection_ids",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "sort",
          "type": "object",
          "schema": "v202601.response.DiscountSortResp"
        },
        {
          "name": "selection",
          "type": "string"
        },
        {
          "name": "sku_extends",
          "type": "object",
          "items": {
            "type": "object",
            "schema": "v202601.response.SkuExtendResp"
          }
        }
      ]
    },
    "v202601.response.DiscountSortResp": {
      "fields": [
        {
          "name": "by",
          "type": "string"
        },
        {
          "name": "direction",
          "type": "string"
        },
        {
          "name": "before",
          "type": "string"
        }
      ]
    },
    "v202601.response.SkuExtendResp": {
      "fields": [
        {
          "name": "obtain_value",
          "type": "string"
        },
        {
          "name": "min_purchase_qty",
          "type": "integer",
          "format": "uint32"
        },
        {
          "name": "seq",
          "type": "integer",
          "format": "uint32"
        },
        {
          "name": "virtual_sales",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "follow_stock",
          "type": "string"
        },
        {
          "name": "stock",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "collection_id",
          "type": "string"
        }
      ]
    },
    "v202601.response.DiscountRuleResp": {
      "fields": [
        {
          "name": "limit_max_discount",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "limit_user_discount",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "limit_order_discount",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "limit_user_product_type",
          "type": "string"
        },
        {
          "name": "limit_user_product_discount",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "stock",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "follow_stock",
          "type": "string"
        },
        {
          "name": "virtual_sales",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "price_rule",
          "type": "string"
        },
        {
          "name": "extends",
          "type": "string"
        },
        {
          "name": "product_discount_order",
          "type": "string"
        },
        {
          "name": "discount_combines",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "obtain_full",
          "type": "boolean"
        },
        {
          "name": "mn_discount_scope",
          "type": "string"
        },
        {
          "name": "limit_code_max_discount",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "limit_code_user_discount",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "enable_product_extends",
          "type": "boolean"
        }
      ]
    },
    "v202601.response.DiscountLayerResp": {
      "fields": [
        {
          "name": "condition_type",
          "type": "string"
        },
        {
          "name": "obtain_type",
          "type": "string"
        },
        {
          "name": "layers",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.response.DiscountLayerItemResp"
          }
        }
      ]
    },
    "v202601.response.DiscountLayerItemResp": {
      "fields": [
        {
          "name": "condition_value",
          "type": "string"
        },
        {
          "name": "obtain_value",
          "type": "string"
        },
        {
          "name": "obtain_count",
          "type": "integer",
          "format": "uint32"
        }
      ]
    },
    "v202601.response.DiscountCombineResp": {
      "fields": [
        {
          "name": "use_with_other",
          "type": "boolean"
        }
      ]
    },
    "v202601.response.DiscountEntitledAreaResp": {
      "fields": [
        {
          "name": "areas",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.response.DiscountAreaResp"
          }
        }
      ]
    },
    "v202601.response.DiscountAreaResp": {
      "fields": [
        {
          "name": "country_code",
          "type": "string"
        },
        {
          "name": "province_codes",
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ]
    },
    "v202601.response.DiscountSummaryResp": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "discount_name",
          "type": "string"
        },
        {
          "name": "display_name",
          "type": "string"
        },
        {
          "name": "discount_target",
          "type": "string"
        },
        {
          "name": "discount_type",
          "type": "string"
        },
        {
          "name": "discount_method",
          "type": "string"
        },
        {
          "name": "discount_code",
          "type": "string"
        },
        {
          "name": "progress",
          "type": "string"
        },
        {
          "name": "starts_at",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "ends_at",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "discount_layer",
          "type": "object",
          "schema": "v202601.response.DiscountLayerResp"
        },
        {
          "name": "discount_rule",
          "type": "object",
          "schema": "v202601.response.DiscountRuleResp"
        },
        {
          "name": "entitled_product",
          "type": "object",
          "schema": "v202601.response.DiscountEntitledProductResp"
        },
        {
          "name": "entitled_customer",
          "type": "object",
          "schema": "v202601.response.DiscountEntitledCustomerResp"
        },
        {
          "name": "obtain_product",
          "type": "object",
          "schema": "v202601.response.DiscountEntitledProductResp"
        },
        {
          "name": "entitled_area",
          "type": "object",
          "schema": "v202601.response.DiscountEntitledAreaResp"
        },
        {
          "name": "source_name",
          "type": "string"
        },
        {
          "name": "starts_date",
          "type": "string"
        },
        {
          "name": "ends_date",
          "type": "string"
        },
        {
          "name": "state",
          "type": "string"
        }
      ]
    },
    "v202506.Order": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "number",
          "type": "string"
        },
        {
          "name": "total_price",
          "type": "string"
        },
        {
          "name": "sub_total",
          "type": "string"
        },
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "financial_status",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "cancelled_at",
          "type": "string"
        },
        {
          "name": "cancel_reason",
          "type": "string"
        },
        {
          "name": "payment_method",
          "type": "string"
        },
        {
          "name": "fulfillment_status",
          "type": "string"
        },
        {
          "name": "customer_deleted_at",
          "type": "string"
        },
        {
          "name": "deleted_at",
          "type": "string"
        },
        {
          "name": "placed_at",
          "type": "string"
        },
        {
          "name": "tags",
          "type": "string"
        },
        {
          "name": "buyer_accepts_marketing",
          "type": "boolean"
        },
        {
          "name": "code_discount_total",
          "type": "string"
        },
        {
          "name": "customer_note",
          "type": "string"
        },
        {
          "name": "total_discount",
          "type": "string"
        },
        {
          "name": "total_tax",
          "type": "string"
        },
        {
          "name": "total_shipping",
          "type": "string"
        },
        {
          "name": "line_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.LineItem"
          }
        },
        {
          "name": "payment_line",
          "type": "object",
          "schema": "v202506.PaymentLine"
        },
        {
          "name": "shipping_line",
          "type": "object",
          "schema": "v202506.ShippingLine"
        },
        {
          "name": "billing_address",
          "type": "object",
          "schema": "v202506.OrderAddress"
        },
        {
          "name": "shipping_address",
          "type": "object",
          "schema": "v202506.OrderAddress"
        },
        {
          "name": "fulfillments",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.Fulfillment"
          }
        },
        {
          "name": "customer",
          "type": "object",
          "schema": "v202506.OrderCustomer"
        },
        {
          "name": "refer_info",
          "type": "string"
        },
        {
          "name": "sales_platform",
          "type": "string"
        },
        {
          "name": "total_refund_price",
          "type": "string"
        },
        {
          "name": "primary_market_price",
          "type": "object",
          "schema": "v202506.MarketPrice"
        },
        {
          "name": "total_tip_received",
          "type": "string"
        },
        {
          "name": "discount_applications",
          "type": "string"
        },
        {
          "name": "refund_status",
          "type": "string"
        },
        {
          "name": "email_status",
          "type": "string"
        },
        {
          "name": "recovery_status",
          "type": "string"
        },
        {
          "name": "total_paid",
          "type": "string"
        },
        {
          "name": "payment_lines",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.PaymentLine"
          }
        },
        {
          "name": "gift_card_total",
          "type": "string"
        },
        {
          "name": "logistics_code",
          "type": "string"
        },
        {
          "name": "shipping_tax_total",
          "type": "string"
        },
        {
          "name": "location_line",
          "type": "object",
          "schema": "v202506.LocationLine"
        },
        {
          "name": "additional_total",
          "type": "string"
        },
        {
          "name": "additional_prices",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.AdditionalPrice"
          }
        },
        {
          "name": "config",
          "type": "object",
          "schema": "v202506.Config"
        },
        {
          "name": "checkout_url",
          "type": "string"
        },
        {
          "name": "duty_total",
          "type": "string"
        },
        {
          "name": "finished_at",
          "type": "string"
        },
        {
          "name": "device",
          "type": "string"
        },
        {
          "name": "order_type",
          "type": "string"
        },
        {
          "name": "source",
          "type": "string"
        },
        {
          "name": "source_name",
          "type": "string"
        },
        {
          "name": "last_landing_url",
          "type": "string"
        },
        {
          "name": "last_referrer_show",
          "type": "string"
        }
      ]
    },
    "v202506.LineItem": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "product_title",
          "type": "string"
        },
        {
          "name": "variant_id",
          "type": "string"
        },
        {
          "name": "variant_title",
          "type": "string"
        },
        {
          "name": "quantity",
          "type": "integer",
          "format": "uint32"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "image",
          "type": "object",
          "schema": "v202506.Image"
        },
        {
          "name": "price",
          "type": "string"
        },
        {
          "name": "compare_at_price",
          "type": "string"
        },
        {
          "name": "total_price",
          "type": "string"
        },
        {
          "name": "fulfillment_status",
          "type": "string"
        },
        {
          "name": "sku",
          "type": "string"
        },
        {
          "name": "weight",
          "type": "string"
        },
        {
          "name": "weight_unit",
          "type": "string"
        },
        {
          "name": "vendor",
          "type": "string"
        },
        {
          "name": "product_url",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "options",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.LineItemOption"
          }
        },
        {
          "name": "product_slug",
          "type": "string"
        },
        {
          "name": "taxable",
          "type": "boolean"
        },
        {
          "name": "requires_shipping",
          "type": "boolean"
        },
        {
          "name": "spu",
          "type": "string"
        },
        {
          "name": "product_tags",
          "type": "string"
        },
        {
          "name": "refund_quantity_total",
          "type": "integer",
          "format": "uint32"
        },
        {
          "name": "ship_quantity",
          "type": "integer",
          "format": "uint32"
        },
        {
          "name": "custom",
          "type": "boolean"
        },
        {
          "name": "trunk_price",
          "type": "string"
        },
        {
          "name": "discount_applications",
          "type": "string"
        },
        {
          "name": "tax_price",
          "type": "string"
        },
        {
          "name": "duty_price",
          "type": "string"
        },
        {
          "name": "payment_discount_price",
          "type": "string"
        },
        {
          "name": "custom_properties",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "v202506.Image": {
      "fields": [
        {
          "name": "src",
          "type": "string"
        },
        {
          "name": "width",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "height",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "alt",
          "type": "string"
        }
      ]
    },
    "v202506.LineItemOption": {
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "value",
          "type": "string"
        }
      ]
    },
    "google.protobuf.Struct": {
      "fields": [
        {
          "name": "fields",
          "type": "object",
          "items": {
            "type": "object",
            "schema": "google.protobuf.Value"
          }
        }
      ]
    },
    "google.protobuf.Value": {
      "fields": [
        {
          "name": "null_value",
          "type": "string",
          "enum": [
            "NULL_VALUE"
          ]
        },
        {
          "name": "number_value",
          "type": "number",
          "format": "double"
        },
        {
          "name": "string_value",
          "type": "string"
        },
        {
          "name": "bool_value",
          "type": "boolean"
        },
        {
          "name": "struct_value",
          "type": "object",
          "schema": "google.protobuf.Struct"
        },
        {
          "name": "list_value",
          "type": "object",
          "schema": "google.protobuf.ListValue"
        }
      ]
    },
    "google.protobuf.ListValue": {
      "fields": [
        {
          "name": "values",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "google.protobuf.Value"
          }
        }
      ]
    },
    "v202506.PaymentLine": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "payment_name",
          "type": "string"
        },
        {
          "name": "payment_channel",
          "type": "string"
        },
        {
          "name": "payment_method",
          "type": "string"
        },
        {
          "name": "credit_card_number",
          "type": "string"
        },
        {
          "name": "trans_channel",
          "type": "string"
        },
        {
          "name": "trans_method",
          "type": "string"
        },
        {
          "name": "transaction_no",
          "type": "string"
        },
        {
          "name": "merchant_email",
          "type": "string"
        }
      ]
    },
    "v202506.ShippingLine": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "desc",
          "type": "string"
        },
        {
          "name": "delivery_method",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202506.OrderAddress": {
      "fields": [
        {
          "name": "first_name",
          "type": "string"
        },
        {
          "name": "last_name",
          "type": "string"
        },
        {
          "name": "address",
          "type": "string"
        },
        {
          "name": "address1",
          "type": "string"
        },
        {
          "name": "phone",
          "type": "string"
        },
        {
          "name": "city",
          "type": "string"
        },
        {
          "name": "zip",
          "type": "string"
        },
        {
          "name": "province",
          "type": "string"
        },
        {
          "name": "country",
          "type": "string"
        },
        {
          "name": "company",
          "type": "string"
        },
        {
          "name": "latitude",
          "type": "string"
        },
        {
          "name": "longitude",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "country_code",
          "type": "string"
        },
        {
          "name": "province_code",
          "type": "string"
        },
        {
          "name": "phone_area_code",
          "type": "string"
        },
        {
          "name": "email",
          "type": "string"
        },
        {
          "name": "area",
          "type": "string"
        },
        {
          "name": "extra_info",
          "type": "object",
          "schema": "v202506.ExtraInfo"
        }
      ]
    },
    "v202506.ExtraInfo": {
      "fields": [
        {
          "name": "addition",
          "type": "object",
          "items": {
            "type": "object",
            "schema": "v202506.AdditionItem"
          }
        },
        {
          "name": "cpf",
          "type": "string"
        },
        {
          "name": "tax_text",
          "type": "string"
        }
      ]
    },
    "v202506.AdditionItem": {
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "val",
          "type": "string"
        }
      ]
    },
    "v202506.Fulfillment": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "order_id",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "tracking_company",
          "type": "string"
        },
        {
          "name": "tracking_number",
          "type": "string"
        },
        {
          "name": "tracking_company_code",
          "type": "string"
        },
        {
          "name": "line_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.LineItem"
          }
        },
        {
          "name": "tracking_url",
          "type": "string"
        },
        {
          "name": "phone_number",
          "type": "string"
        }
      ]
    },
    "v202506.OrderCustomer": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "email",
          "type": "string"
        },
        {
          "name": "first_name",
          "type": "string"
        },
        {
          "name": "last_name",
          "type": "string"
        },
        {
          "name": "phone",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "order_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "total_spent",
          "type": "string"
        }
      ]
    },
    "v202506.MarketPrice": {
      "fields": [
        {
          "name": "compare_at_price",
          "type": "string"
        },
        {
          "name": "price",
          "type": "string"
        },
        {
          "name": "total_price",
          "type": "string"
        },
        {
          "name": "actual_rate",
          "type": "string"
        }
      ]
    },
    "v202506.LocationLine": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "location_id",
          "type": "string"
        },
        {
          "name": "location_name",
          "type": "string"
        }
      ]
    },
    "v202506.AdditionalPrice": {
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "price",
          "type": "string"
        },
        {
          "name": "biz_id",
          "type": "string"
        },
        {
          "name": "fee_title",
          "type": "string"
        }
      ]
    },
    "v202506.Config": {
      "fields": [
        {
          "name": "page_type",
          "type": "string"
        },
        {
          "name": "requires_shipping",
          "type": "boolean"
        },
        {
          "name": "product_tax_included",
          "type": "boolean"
        },
        {
          "name": "market_setting",
          "type": "object",
          "schema": "v202506.MarketSetting"
        }
      ]
    },
    "v202506.MarketSetting": {
      "fields": [
        {
          "name": "primary_market_lang",
          "type": "string"
        },
        {
          "name": "market_lang",
          "type": "string"
        },
        {
          "name": "market_id",
          "type": "string"
        },
        {
          "name": "market_currency",
          "type": "string"
        },
        {
          "name": "market_currency_symbol",
          "type": "object",
          "schema": "v202506.CurrencySymbol"
        },
        {
          "name": "market_base_id",
          "type": "string"
        },
        {
          "name": "market_base_currency",
          "type": "string"
        },
        {
          "name": "market_base_currency_symbol",
          "type": "object",
          "schema": "v202506.CurrencySymbol"
        },
        {
          "name": "primary_market_id",
          "type": "string"
        },
        {
          "name": "primary_market_currency",
          "type": "string"
        },
        {
          "name": "primary_market_currency_symbol",
          "type": "object",
          "schema": "v202506.CurrencySymbol"
        },
        {
          "name": "market_price_setting",
          "type": "object",
          "schema": "v202506.MarketPriceSetting"
        },
        {
          "name": "market_country",
          "type": "string"
        }
      ]
    },
    "v202506.CurrencySymbol": {
      "fields": [
        {
          "name": "code",
          "type": "string"
        },
        {
          "name": "val",
          "type": "string"
        },
        {
          "name": "left",
          "type": "string"
        },
        {
          "name": "right",
          "type": "string"
        }
      ]
    },
    "v202506.MarketPriceSetting": {
      "fields": [
        {
          "name": "local_currency_enabled",
          "type": "boolean"
        },
        {
          "name": "custom_rate_enabled",
          "type": "boolean"
        },
        {
          "name": "custom_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "back_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "actual_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "base_to_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "local_to_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "adjust",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "price_round_enabled",
          "type": "boolean"
        }
      ]
    },
    "v202601.Order": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "number",
          "type": "string"
        },
        {
          "name": "total_price",
          "type": "string"
        },
        {
          "name": "sub_total",
          "type": "string"
        },
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "financial_status",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "cancelled_at",
          "type": "string"
        },
        {
          "name": "cancel_reason",
          "type": "string"
        },
        {
          "name": "payment_method",
          "type": "string"
        },
        {
          "name": "fulfillment_status",
          "type": "string"
        },
        {
          "name": "customer_deleted_at",
          "type": "string"
        },
        {
          "name": "deleted_at",
          "type": "string"
        },
        {
          "name": "placed_at",
          "type": "string"
        },
        {
          "name": "tags",
          "type": "string"
        },
        {
          "name": "buyer_accepts_marketing",
          "type": "boolean"
        },
        {
          "name": "code_discount_total",
          "type": "string"
        },
        {
          "name": "customer_note",
          "type": "string"
        },
        {
          "name": "total_discount",
          "type": "string"
        },
        {
          "name": "total_tax",
          "type": "string"
        },
        {
          "name": "total_shipping",
          "type": "string"
        },
        {
          "name": "line_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.OrderLineItem"
          }
        },
        {
          "name": "payment_line",
          "type": "object",
          "schema": "v202601.PaymentLine"
        },
        {
          "name": "shipping_line",
          "type": "object",
          "schema": "v202601.ShippingLine"
        },
        {
          "name": "billing_address",
          "type": "object",
          "schema": "v202601.OrderAddress"
        },
        {
          "name": "shipping_address",
          "type": "object",
          "schema": "v202601.OrderAddress"
        },
        {
          "name": "fulfillments",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.OrderFulfillment"
          }
        },
        {
          "name": "customer",
          "type": "object",
          "schema": "v202601.OrderCustomer"
        },
        {
          "name": "refer_info",
          "type": "string"
        },
        {
          "name": "sales_platform",
          "type": "string"
        },
        {
          "name": "total_refund_price",
          "type": "string"
        },
        {
          "name": "primary_market_price",
          "type": "object",
          "schema": "v202601.MarketPrice"
        },
        {
          "name": "total_tip_received",
          "type": "string"
        },
        {
          "name": "discount_applications",
          "type": "string"
        },
        {
          "name": "refund_status",
          "type": "string"
        },
        {
          "name": "email_status",
          "type": "string"
        },
        {
          "name": "recovery_status",
          "type": "string"
        },
        {
          "name": "total_paid",
          "type": "string"
        },
        {
          "name": "payment_lines",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.PaymentLine"
          }
        },
        {
          "name": "gift_card_total",
          "type": "string"
        },
        {
          "name": "logistics_code",
          "type": "string"
        },
        {
          "name": "shipping_tax_total",
          "type": "string"
        },
        {
          "name": "location_line",
          "type": "object",
          "schema": "v202601.LocationLine"
        },
        {
          "name": "additional_total",
          "type": "string"
        },
        {
          "name": "additional_prices",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.AdditionalPrice"
          }
        },
        {
          "name": "config",
          "type": "object",
          "schema": "v202601.Config"
        },
        {
          "name": "checkout_url",
          "type": "string"
        },
        {
          "name": "duty_total",
          "type": "string"
        },
        {
          "name": "order_confirm_notify",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "fulfillment_notify",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "partial_fulfillment_notify",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "order_delivered_notify",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "finished_at",
          "type": "string"
        },
        {
          "name": "device",
          "type": "string"
        },
        {
          "name": "order_type",
          "type": "string"
        },
        {
          "name": "source",
          "type": "string"
        },
        {
          "name": "source_name",
          "type": "string"
        },
        {
          "name": "last_landing_url",
          "type": "string"
        },
        {
          "name": "last_referrer_show",
          "type": "string"
        },
        {
          "name": "browser_ip",
          "type": "string"
        },
        {
          "name": "custom_fields",
          "type": "object",
          "items": {
            "type": "string"
          }
        }
      ]
    },
    "v202601.OrderLineItem": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "product_title",
          "type": "string"
        },
        {
          "name": "variant_id",
          "type": "string"
        },
        {
          "name": "variant_title",
          "type": "string"
        },
        {
          "name": "quantity",
          "type": "integer",
          "format": "uint32"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "image",
          "type": "object",
          "schema": "v202506.Image"
        },
        {
          "name": "price",
          "type": "string"
        },
        {
          "name": "compare_at_price",
          "type": "string"
        },
        {
          "name": "total_price",
          "type": "string"
        },
        {
          "name": "fulfillment_status",
          "type": "string"
        },
        {
          "name": "sku",
          "type": "string"
        },
        {
          "name": "weight",
          "type": "string"
        },
        {
          "name": "weight_unit",
          "type": "string"
        },
        {
          "name": "vendor",
          "type": "string"
        },
        {
          "name": "product_url",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "options",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.LineItemOption"
          }
        },
        {
          "name": "product_slug",
          "type": "string"
        },
        {
          "name": "taxable",
          "type": "boolean"
        },
        {
          "name": "requires_shipping",
          "type": "boolean"
        },
        {
          "name": "spu",
          "type": "string"
        },
        {
          "name": "product_tags",
          "type": "string"
        },
        {
          "name": "refund_quantity_total",
          "type": "integer",
          "format": "uint32"
        },
        {
          "name": "custom",
          "type": "boolean"
        },
        {
          "name": "trunk_price",
          "type": "string"
        },
        {
          "name": "discount_applications",
          "type": "string"
        },
        {
          "name": "tax_price",
          "type": "string"
        },
        {
          "name": "duty_price",
          "type": "string"
        },
        {
          "name": "payment_discount_price",
          "type": "string"
        },
        {
          "name": "custom_properties",
          "type": "object",
          "schema": "google.protobuf.Struct"
        }
      ]
    },
    "v202601.PaymentLine": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "payment_name",
          "type": "string"
        },
        {
          "name": "payment_channel",
          "type": "string"
        },
        {
          "name": "payment_method",
          "type": "string"
        },
        {
          "name": "credit_card_number",
          "type": "string"
        },
        {
          "name": "trans_channel",
          "type": "string"
        },
        {
          "name": "trans_method",
          "type": "string"
        },
        {
          "name": "transaction_no",
          "type": "string"
        },
        {
          "name": "merchant_email",
          "type": "string"
        }
      ]
    },
    "v202601.ShippingLine": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "desc",
          "type": "string"
        },
        {
          "name": "delivery_method",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202601.OrderAddress": {
      "fields": [
        {
          "name": "first_name",
          "type": "string"
        },
        {
          "name": "last_name",
          "type": "string"
        },
        {
          "name": "address",
          "type": "string"
        },
        {
          "name": "address1",
          "type": "string"
        },
        {
          "name": "phone",
          "type": "string"
        },
        {
          "name": "city",
          "type": "string"
        },
        {
          "name": "zip",
          "type": "string"
        },
        {
          "name": "province",
          "type": "string"
        },
        {
          "name": "country",
          "type": "string"
        },
        {
          "name": "company",
          "type": "string"
        },
        {
          "name": "latitude",
          "type": "string"
        },
        {
          "name": "longitude",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "country_code",
          "type": "string"
        },
        {
          "name": "province_code",
          "type": "string"
        },
        {
          "name": "phone_area_code",
          "type": "string"
        },
        {
          "name": "email",
          "type": "string"
        },
        {
          "name": "area",
          "type": "string"
        },
        {
          "name": "extra_info",
          "type": "object",
          "schema": "v202601.ExtraInfo"
        }
      ]
    },
    "v202601.ExtraInfo": {
      "fields": [
        {
          "name": "addition",
          "type": "object",
          "items": {
            "type": "object",
            "schema": "v202601.AdditionItem"
          }
        },
        {
          "name": "cpf",
          "type": "string"
        },
        {
          "name": "tax_text",
          "type": "string"
        },
        {
          "name": "id_number",
          "type": "string"
        },
        {
          "name": "id_number_text",
          "type": "string"
        }
      ]
    },
    "v202601.AdditionItem": {
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "val",
          "type": "string"
        }
      ]
    },
    "v202601.OrderFulfillment": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "order_id",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "tracking_company",
          "type": "string"
        },
        {
          "name": "tracking_number",
          "type": "string"
        },
        {
          "name": "tracking_company_code",
          "type": "string"
        },
        {
          "name": "line_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.LineItem"
          }
        },
        {
          "name": "tracking_url",
          "type": "string"
        },
        {
          "name": "phone_number",
          "type": "string"
        },
        {
          "name": "tracking_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.TrackingItem"
          }
        }
      ]
    },
    "v202601.TrackingItem": {
      "fields": [
        {
          "name": "tracking_number",
          "type": "string"
        },
        {
          "name": "tracking_company",
          "type": "string"
        },
        {
          "name": "tracking_company_code",
          "type": "string"
        },
        {
          "name": "tracking_url",
          "type": "string"
        }
      ]
    },
    "v202601.OrderCustomer": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "email",
          "type": "string"
        },
        {
          "name": "first_name",
          "type": "string"
        },
        {
          "name": "last_name",
          "type": "string"
        },
        {
          "name": "phone",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "order_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "total_spent",
          "type": "string"
        }
      ]
    },
    "v202601.MarketPrice": {
      "fields": [
        {
          "name": "compare_at_price",
          "type": "string"
        },
        {
          "name": "price",
          "type": "string"
        },
        {
          "name": "total_price",
          "type": "string"
        },
        {
          "name": "actual_rate",
          "type": "string"
        }
      ]
    },
    "v202601.LocationLine": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "location_id",
          "type": "string"
        },
        {
          "name": "location_name",
          "type": "string"
        }
      ]
    },
    "v202601.AdditionalPrice": {
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "price",
          "type": "string"
        },
        {
          "name": "biz_id",
          "type": "string"
        },
        {
          "name": "fee_title",
          "type": "string"
        }
      ]
    },
    "v202601.Config": {
      "fields": [
        {
          "name": "page_type",
          "type": "string"
        },
        {
          "name": "requires_shipping",
          "type": "boolean"
        },
        {
          "name": "product_tax_included",
          "type": "boolean"
        },
        {
          "name": "market_setting",
          "type": "object",
          "schema": "v202601.MarketSetting"
        }
      ]
    },
    "v202601.MarketSetting": {
      "fields": [
        {
          "name": "primary_market_lang",
          "type": "string"
        },
        {
          "name": "market_lang",
          "type": "string"
        },
        {
          "name": "market_id",
          "type": "string"
        },
        {
          "name": "market_currency",
          "type": "string"
        },
        {
          "name": "market_currency_symbol",
          "type": "object",
          "schema": "v202601.CurrencySymbol"
        },
        {
          "name": "market_base_id",
          "type": "string"
        },
        {
          "name": "market_base_currency",
          "type": "string"
        },
        {
          "name": "market_base_currency_symbol",
          "type": "object",
          "schema": "v202601.CurrencySymbol"
        },
        {
          "name": "primary_market_id",
          "type": "string"
        },
        {
          "name": "primary_market_currency",
          "type": "string"
        },
        {
          "name": "primary_market_currency_symbol",
          "type": "object",
          "schema": "v202601.CurrencySymbol"
        },
        {
          "name": "market_price_setting",
          "type": "object",
          "schema": "v202601.MarketPriceSetting"
        },
        {
          "name": "market_country",
          "type": "string"
        }
      ]
    },
    "v202601.CurrencySymbol": {
      "fields": [
        {
          "name": "code",
          "type": "string"
        },
        {
          "name": "val",
          "type": "string"
        },
        {
          "name": "left",
          "type": "string"
        },
        {
          "name": "right",
          "type": "string"
        }
      ]
    },
    "v202601.MarketPriceSetting": {
      "fields": [
        {
          "name": "local_currency_enabled",
          "type": "boolean"
        },
        {
          "name": "custom_rate_enabled",
          "type": "boolean"
        },
        {
          "name": "custom_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "back_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "actual_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "base_to_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "local_to_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "adjust",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "price_round_enabled",
          "type": "boolean"
        }
      ]
    },
    "v202601.FulfillmentSummary": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "order_id",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "tracking_company",
          "type": "string"
        },
        {
          "name": "tracking_number",
          "type": "string"
        },
        {
          "name": "tracking_company_code",
          "type": "string"
        },
        {
          "name": "line_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.LineItem"
          }
        },
        {
          "name": "tracking_url",
          "type": "string"
        },
        {
          "name": "phone_number",
          "type": "string"
        }
      ]
    },
    "v202601.Fulfillment": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "order_id",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "tracking_company",
          "type": "string"
        },
        {
          "name": "tracking_number",
          "type": "string"
        },
        {
          "name": "tracking_company_code",
          "type": "string"
        },
        {
          "name": "line_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.LineItem"
          }
        },
        {
          "name": "tracking_url",
          "type": "string"
        },
        {
          "name": "phone_number",
          "type": "string"
        },
        {
          "name": "tracking_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.TrackingItem"
          }
        }
      ]
    },
    "v202506.PostSaleOrder": {
      "fields": [
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "credit_card_number",
          "type": "string"
        },
        {
          "name": "currency_code",
          "type": "string"
        },
        {
          "name": "customer_name",
          "type": "string"
        },
        {
          "name": "discount_code",
          "type": "string"
        },
        {
          "name": "financial_status",
          "type": "string"
        },
        {
          "name": "fulfillment_status",
          "type": "string"
        },
        {
          "name": "fulfillments",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.PostSaleOrderFulfillment"
          }
        },
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "line_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.PostSaleOrderLineItem"
          }
        },
        {
          "name": "number",
          "type": "string"
        },
        {
          "name": "order_number",
          "type": "string"
        },
        {
          "name": "order_total",
          "type": "string"
        },
        {
          "name": "payment_method",
          "type": "string"
        },
        {
          "name": "recipient_name",
          "type": "string"
        },
        {
          "name": "sales_platform",
          "type": "string"
        },
        {
          "name": "shipping_country",
          "type": "string"
        },
        {
          "name": "shipping_email",
          "type": "string"
        },
        {
          "name": "shipping_line",
          "type": "object",
          "schema": "v202506.ShippingLine"
        },
        {
          "name": "shipping_phone",
          "type": "string"
        },
        {
          "name": "source",
          "type": "string"
        },
        {
          "name": "source_name",
          "type": "string"
        },
        {
          "name": "placed_at",
          "type": "string"
        },
        {
          "name": "refund_amount",
          "type": "string"
        },
        {
          "name": "post_sale_note",
          "type": "string"
        },
        {
          "name": "last_referrer_show",
          "type": "string"
        },
        {
          "name": "last_landing_url",
          "type": "string"
        },
        {
          "name": "payment_lines",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.PaymentLine"
          }
        },
        {
          "name": "main_currency_prices",
          "type": "object",
          "schema": "v202506.MarketPrice"
        },
        {
          "name": "delivery_method",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "shipping_tax_total",
          "type": "string"
        },
        {
          "name": "shipping_tax_type",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "all_tax_total",
          "type": "string"
        },
        {
          "name": "shop_name",
          "type": "string"
        },
        {
          "name": "staff_contact",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        }
      ]
    },
    "v202506.PostSaleOrderFulfillment": {
      "fields": [
        {
          "name": "tracking_number",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "tracking_company",
          "type": "string"
        }
      ]
    },
    "v202506.PostSaleOrderLineItem": {
      "fields": [
        {
          "name": "compare_at_price",
          "type": "string"
        },
        {
          "name": "fulfillment_status",
          "type": "string"
        },
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "image",
          "type": "object",
          "schema": "v202506.Image"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "options",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.LineItemOption"
          }
        },
        {
          "name": "price",
          "type": "string"
        },
        {
          "name": "product_handle",
          "type": "string"
        },
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "product_tags",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "product_title",
          "type": "string"
        },
        {
          "name": "properties",
          "type": "string"
        },
        {
          "name": "quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "refund_discount",
          "type": "string"
        },
        {
          "name": "refund_price",
          "type": "string"
        },
        {
          "name": "refund_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "refund_tax",
          "type": "string"
        },
        {
          "name": "refund_total",
          "type": "string"
        },
        {
          "name": "requires_shipping",
          "type": "boolean"
        },
        {
          "name": "sku",
          "type": "string"
        },
        {
          "name": "spu",
          "type": "string"
        },
        {
          "name": "taxable",
          "type": "boolean"
        },
        {
          "name": "total",
          "type": "string"
        },
        {
          "name": "variant_id",
          "type": "string"
        },
        {
          "name": "variant_title",
          "type": "string"
        },
        {
          "name": "vendor",
          "type": "string"
        },
        {
          "name": "weight",
          "type": "string"
        },
        {
          "name": "weight_unit",
          "type": "string"
        },
        {
          "name": "vendor_url",
          "type": "string"
        },
        {
          "name": "oversold_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "main_currency_prices",
          "type": "object",
          "schema": "v202506.MarketPrice"
        },
        {
          "name": "fulfillments",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.PostSaleOrderFulfillment"
          }
        }
      ]
    },
    "v202601.V202601RefundRecord": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "refund_price",
          "type": "string"
        },
        {
          "name": "refund_shipping",
          "type": "string"
        },
        {
          "name": "refund_shipping_tax",
          "type": "string"
        },
        {
          "name": "refund_method",
          "type": "string"
        },
        {
          "name": "refund_status",
          "type": "string"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "refund_line_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.RefundLineItem"
          }
        },
        {
          "name": "payment_details",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.RefundPaymentDetail"
          }
        },
        {
          "name": "additional_total",
          "type": "string"
        },
        {
          "name": "additional_prices",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.AdditionalPrice"
          }
        },
        {
          "name": "refund_tip",
          "type": "string"
        },
        {
          "name": "order_id",
          "type": "string"
        },
        {
          "name": "extra_info",
          "type": "object",
          "schema": "v202601.RefundRecordExtraInfo"
        }
      ]
    },
    "v202601.RefundLineItem": {
      "fields": [
        {
          "name": "line_item_id",
          "type": "string"
        },
        {
          "name": "refund_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "tax",
          "type": "string"
        },
        {
          "name": "discount",
          "type": "string"
        },
        {
          "name": "sub_total",
          "type": "string"
        },
        {
          "name": "total",
          "type": "string"
        },
        {
          "name": "delete_quantity",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202601.RefundPaymentDetail": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "payment_line_id",
          "type": "string"
        },
        {
          "name": "payment_channel",
          "type": "string"
        },
        {
          "name": "payment_method",
          "type": "string"
        },
        {
          "name": "refund_price",
          "type": "string"
        },
        {
          "name": "refund_status",
          "type": "string"
        },
        {
          "name": "finished_at",
          "type": "string"
        }
      ]
    },
    "v202601.RefundRecordExtraInfo": {
      "fields": [
        {
          "name": "pos",
          "type": "string"
        }
      ]
    },
    "v202506.RefundRecord": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "refund_price",
          "type": "string"
        },
        {
          "name": "refund_shipping",
          "type": "string"
        },
        {
          "name": "refund_shipping_tax",
          "type": "string"
        },
        {
          "name": "refund_method",
          "type": "string"
        },
        {
          "name": "refund_status",
          "type": "string"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "refund_line_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.RefundLineItem"
          }
        },
        {
          "name": "payment_details",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.RefundPaymentDetail"
          }
        },
        {
          "name": "additional_total",
          "type": "string"
        },
        {
          "name": "additional_prices",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.AdditionalPrice"
          }
        },
        {
          "name": "refund_tip",
          "type": "string"
        },
        {
          "name": "order_id",
          "type": "string"
        }
      ]
    },
    "v202506.RefundLineItem": {
      "fields": [
        {
          "name": "line_item_id",
          "type": "string"
        },
        {
          "name": "refund_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "tax",
          "type": "string"
        },
        {
          "name": "discount",
          "type": "string"
        },
        {
          "name": "sub_total",
          "type": "string"
        },
        {
          "name": "total",
          "type": "string"
        },
        {
          "name": "delete_quantity",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202506.RefundPaymentDetail": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "payment_line_id",
          "type": "string"
        },
        {
          "name": "payment_channel",
          "type": "string"
        },
        {
          "name": "payment_method",
          "type": "string"
        },
        {
          "name": "refund_price",
          "type": "string"
        },
        {
          "name": "refund_status",
          "type": "string"
        },
        {
          "name": "finished_at",
          "type": "string"
        }
      ]
    },
    "v202506.OrderRisk": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "order_id",
          "type": "string"
        },
        {
          "name": "level",
          "type": "string"
        },
        {
          "name": "details",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "properties",
          "type": "object",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.OrderRiskAssessmentInfo": {
      "fields": [
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "describe",
          "type": "string"
        }
      ]
    },
    "v202506.ShippingSchemasShipping": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "schema_id",
          "type": "string"
        },
        {
          "name": "support_cod",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "plans",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ShippingPlan"
          }
        },
        {
          "name": "areas",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ShippingArea"
          }
        }
      ]
    },
    "v202506.ShippingPlan": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "shipping_id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "desc",
          "type": "string"
        },
        {
          "name": "support_cod",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "rule_type",
          "type": "string"
        },
        {
          "name": "rule_range_min",
          "type": "string"
        },
        {
          "name": "rule_range_max",
          "type": "string"
        },
        {
          "name": "rule_range_infinite",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "rule_range_unit",
          "type": "string"
        },
        {
          "name": "rate_type",
          "type": "string"
        },
        {
          "name": "rate_amount",
          "type": "string"
        },
        {
          "name": "rate_first_range",
          "type": "string"
        },
        {
          "name": "rate_first_unit",
          "type": "string"
        },
        {
          "name": "rate_additional_amount",
          "type": "string"
        },
        {
          "name": "rate_additional_unit",
          "type": "string"
        },
        {
          "name": "rate_additional_range",
          "type": "string"
        },
        {
          "name": "store_id",
          "type": "string"
        },
        {
          "name": "created_time",
          "type": "string"
        },
        {
          "name": "updated_time",
          "type": "string"
        },
        {
          "name": "plan_type",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "plan_type_value",
          "type": "string"
        },
        {
          "name": "rule_type_scope",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202506.ShippingArea": {
      "fields": [
        {
          "name": "shipping_id",
          "type": "string"
        },
        {
          "name": "country_name",
          "type": "string"
        },
        {
          "name": "country_code",
          "type": "string"
        },
        {
          "name": "province_codes",
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ]
    },
    "v202506.AvailableShippingLine": {
      "fields": [
        {
          "name": "delivery_method",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "desc",
          "type": "string"
        },
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "location_id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "plan_code",
          "type": "string"
        },
        {
          "name": "shipping_price",
          "type": "string"
        },
        {
          "name": "support_cod",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202506.ShippingSchemas": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "schema_type",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "variant_num",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "shippings",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.ShippingSchemasShipping"
          }
        }
      ]
    },
    "v202506.TrackingCarrier": {
      "fields": [
        {
          "name": "code",
          "type": "string"
        },
        {
          "name": "en_name",
          "type": "string"
        },
        {
          "name": "cn_name",
          "type": "string"
        }
      ]
    },
    "v202506.Transaction": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "order_id",
          "type": "string"
        },
        {
          "name": "payment_channel",
          "type": "string"
        },
        {
          "name": "message",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "test",
          "type": "boolean"
        },
        {
          "name": "error_code",
          "type": "string"
        },
        {
          "name": "amount",
          "type": "string"
        },
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "trade_id",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "payment_name",
          "type": "string"
        },
        {
          "name": "payment_detail",
          "type": "object",
          "schema": "v202506.PaymentDetail"
        }
      ]
    },
    "v202506.PaymentDetail": {
      "fields": [
        {
          "name": "card_number",
          "type": "string"
        },
        {
          "name": "card_month",
          "type": "string"
        },
        {
          "name": "card_year",
          "type": "string"
        },
        {
          "name": "card_first_name",
          "type": "string"
        },
        {
          "name": "card_last_name",
          "type": "string"
        },
        {
          "name": "card_first_fix",
          "type": "string"
        },
        {
          "name": "card_last_four",
          "type": "string"
        },
        {
          "name": "avs_result_code",
          "type": "string"
        },
        {
          "name": "cvv_result_code",
          "type": "string"
        }
      ]
    },
    "v202506.CategoryParam": {
      "fields": [
        {
          "name": "id",
          "type": "integer",
          "format": "uint64"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "pid",
          "type": "integer",
          "format": "uint64"
        },
        {
          "name": "level",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "position",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "path",
          "type": "string"
        },
        {
          "name": "google_id",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202601.Collection": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "description",
          "type": "string"
        },
        {
          "name": "handle",
          "type": "string"
        },
        {
          "name": "smart",
          "type": "boolean"
        },
        {
          "name": "image",
          "type": "object",
          "schema": "v202601.Image"
        },
        {
          "name": "seo_title",
          "type": "string"
        },
        {
          "name": "seo_keywords",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "seo_description",
          "type": "string"
        },
        {
          "name": "sort_order",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "match_rules",
          "type": "object",
          "schema": "v202601.MatchRule"
        },
        {
          "name": "tags",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "product_count",
          "type": "integer",
          "format": "int64"
        }
      ]
    },
    "v202601.Image": {
      "fields": [
        {
          "name": "src",
          "type": "string"
        },
        {
          "name": "width",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "height",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "alt",
          "type": "string"
        }
      ]
    },
    "v202601.MatchRule": {
      "fields": [
        {
          "name": "disjunctive",
          "type": "boolean"
        },
        {
          "name": "rule_modules",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.RuleModule"
          }
        }
      ]
    },
    "v202601.RuleModule": {
      "fields": [
        {
          "name": "disjunctive",
          "type": "boolean"
        },
        {
          "name": "rules",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.Rule"
          }
        }
      ]
    },
    "v202601.Rule": {
      "fields": [
        {
          "name": "column",
          "type": "string"
        },
        {
          "name": "relation",
          "type": "string"
        },
        {
          "name": "condition",
          "type": "string"
        }
      ]
    },
    "v202601.AsyncTask": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "source_id",
          "type": "string"
        },
        {
          "name": "task_type",
          "type": "string"
        },
        {
          "name": "state",
          "type": "string"
        },
        {
          "name": "message",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "task_data",
          "type": "object",
          "schema": "google.protobuf.Any"
        }
      ]
    },
    "google.protobuf.Any": {
      "fields": [
        {
          "name": "type_url",
          "type": "string"
        },
        {
          "name": "value",
          "type": "string",
          "format": "byte"
        }
      ]
    },
    "v202506.Collect": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "collection_id",
          "type": "string"
        },
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "position",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.BatchCreateCommentError": {
      "fields": [
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "user_name",
          "type": "string"
        },
        {
          "name": "star",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "like",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "content",
          "type": "string"
        },
        {
          "name": "country",
          "type": "string"
        },
        {
          "name": "images",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "product_published",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "error_message",
          "type": "string"
        }
      ]
    },
    "v202506.Comment": {
      "fields": [
        {
          "name": "id",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "store_id",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "user_name",
          "type": "string"
        },
        {
          "name": "email",
          "type": "string"
        },
        {
          "name": "star",
          "type": "string"
        },
        {
          "name": "like",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "content",
          "type": "string"
        },
        {
          "name": "images",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "status",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "type",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "country",
          "type": "string"
        },
        {
          "name": "is_featured",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "is_verified",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "client_id",
          "type": "string"
        },
        {
          "name": "anonymous",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "product_published",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202506.ProductRes": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "description",
          "type": "string"
        },
        {
          "name": "published",
          "type": "boolean"
        },
        {
          "name": "requires_shipping",
          "type": "boolean"
        },
        {
          "name": "taxable",
          "type": "boolean"
        },
        {
          "name": "tags",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "vendor",
          "type": "string"
        },
        {
          "name": "vendor_url",
          "type": "string"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "seo_title",
          "type": "string"
        },
        {
          "name": "seo_description",
          "type": "string"
        },
        {
          "name": "seo_keywords",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "handle",
          "type": "string"
        },
        {
          "name": "has_only_default_variant",
          "type": "boolean"
        },
        {
          "name": "inventory_tracking",
          "type": "boolean"
        },
        {
          "name": "inventory_policy",
          "type": "string"
        },
        {
          "name": "need_variant_image",
          "type": "boolean"
        },
        {
          "name": "spu",
          "type": "string"
        },
        {
          "name": "fake_sales",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "display_fake_sales",
          "type": "boolean"
        },
        {
          "name": "options",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.OptionRes"
          }
        },
        {
          "name": "images",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.FullImageRes"
          }
        },
        {
          "name": "variants",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.VariantParam"
          }
        },
        {
          "name": "mixed_wholesale",
          "type": "boolean"
        },
        {
          "name": "product_type",
          "type": "string"
        },
        {
          "name": "brand",
          "type": "string"
        },
        {
          "name": "brief",
          "type": "string"
        },
        {
          "name": "inventory_quantity",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "price_min",
          "type": "number",
          "format": "double"
        },
        {
          "name": "price_max",
          "type": "number",
          "format": "double"
        },
        {
          "name": "compare_at_price_min",
          "type": "number",
          "format": "double"
        },
        {
          "name": "compare_at_price_max",
          "type": "number",
          "format": "double"
        },
        {
          "name": "published_at",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "sales",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "independent_seo",
          "type": "boolean"
        },
        {
          "name": "url",
          "type": "string"
        },
        {
          "name": "available",
          "type": "boolean"
        },
        {
          "name": "retail_price_min",
          "type": "number",
          "format": "double"
        },
        {
          "name": "retail_price_max",
          "type": "number",
          "format": "double"
        },
        {
          "name": "origin_price_min",
          "type": "number",
          "format": "double"
        },
        {
          "name": "origin_price_max",
          "type": "number",
          "format": "double"
        },
        {
          "name": "primary_image",
          "type": "object",
          "schema": "v202506.ImageRes"
        },
        {
          "name": "tax_code",
          "type": "string"
        },
        {
          "name": "category_id",
          "type": "string"
        },
        {
          "name": "category",
          "type": "object",
          "schema": "v202506.Category"
        }
      ]
    },
    "v202506.OptionRes": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "values",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "position",
          "type": "integer",
          "format": "int64"
        }
      ]
    },
    "v202506.FullImageRes": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "src",
          "type": "string"
        },
        {
          "name": "width",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "height",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "alt",
          "type": "string"
        },
        {
          "name": "position",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "path",
          "type": "string"
        }
      ]
    },
    "v202506.VariantParam": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "image_id",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "option1",
          "type": "string"
        },
        {
          "name": "option2",
          "type": "string"
        },
        {
          "name": "option3",
          "type": "string"
        },
        {
          "name": "image",
          "type": "object",
          "schema": "v202506.ImageParam"
        },
        {
          "name": "position",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "compare_at_price",
          "type": "number",
          "format": "double"
        },
        {
          "name": "price",
          "type": "number",
          "format": "double"
        },
        {
          "name": "sku",
          "type": "string"
        },
        {
          "name": "barcode",
          "type": "string"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "inventory_quantity",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "weight",
          "type": "number",
          "format": "double"
        },
        {
          "name": "weight_unit",
          "type": "string"
        },
        {
          "name": "cost_price",
          "type": "number",
          "format": "double"
        },
        {
          "name": "wholesale_price",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.WholePrice"
          }
        },
        {
          "name": "whole_prices",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.WholePrice"
          }
        },
        {
          "name": "retail_price",
          "type": "number",
          "format": "double"
        },
        {
          "name": "is_discount",
          "type": "boolean"
        },
        {
          "name": "origin_price",
          "type": "number",
          "format": "double"
        },
        {
          "name": "extend",
          "type": "object",
          "schema": "v202506.Extend"
        }
      ]
    },
    "v202506.ImageParam": {
      "fields": [
        {
          "name": "src",
          "type": "string"
        },
        {
          "name": "width",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "height",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "alt",
          "type": "string"
        },
        {
          "name": "path",
          "type": "string"
        }
      ]
    },
    "v202506.WholePrice": {
      "fields": [
        {
          "name": "price",
          "type": "number",
          "format": "double",
          "required": true,
          "minimum": 0
        },
        {
          "name": "min_quantity",
          "type": "integer",
          "format": "int64",
          "required": true,
          "minimum": 0
        }
      ]
    },
    "v202506.Extend": {
      "fields": [
        {
          "name": "length",
          "type": "number",
          "format": "double"
        },
        {
          "name": "width",
          "type": "number",
          "format": "double"
        },
        {
          "name": "height",
          "type": "number",
          "format": "double"
        },
        {
          "name": "dimension_unit",
          "type": "string"
        },
        {
          "name": "origin_country_code",
          "type": "string"
        },
        {
          "name": "hs_code",
          "type": "string"
        }
      ]
    },
    "v202506.ImageRes": {
      "fields": [
        {
          "name": "src",
          "type": "string"
        },
        {
          "name": "width",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "height",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "alt",
          "type": "string"
        },
        {
          "name": "path",
          "type": "string"
        }
      ]
    },
    "v202506.Category": {
      "fields": [
        {
          "name": "id",
          "type": "integer",
          "format": "uint64"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "google_id",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "level",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "path",
          "type": "string"
        }
      ]
    },
    "v202506.BatchCreateGiftCard": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "last_characters",
          "type": "string"
        },
        {
          "name": "balance",
          "type": "string"
        },
        {
          "name": "initial_value",
          "type": "string"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "expires_on",
          "type": "string"
        },
        {
          "name": "disabled_at",
          "type": "string"
        },
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "line_item_id",
          "type": "string"
        },
        {
          "name": "order_id",
          "type": "string"
        },
        {
          "name": "user_id",
          "type": "string"
        },
        {
          "name": "template_suffix",
          "type": "string"
        },
        {
          "name": "customer_id",
          "type": "string"
        },
        {
          "name": "code",
          "type": "string"
        }
      ]
    },
    "v202506.GiftCard": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "last_characters",
          "type": "string"
        },
        {
          "name": "balance",
          "type": "string"
        },
        {
          "name": "initial_value",
          "type": "string"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "expires_on",
          "type": "string"
        },
        {
          "name": "disabled_at",
          "type": "string"
        },
        {
          "name": "enabled",
          "type": "boolean"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "line_item_id",
          "type": "string"
        },
        {
          "name": "order_id",
          "type": "string"
        },
        {
          "name": "user_id",
          "type": "string"
        },
        {
          "name": "template_suffix",
          "type": "string"
        },
        {
          "name": "customer_id",
          "type": "string"
        },
        {
          "name": "code",
          "type": "string"
        }
      ]
    },
    "v202506.ProductImage": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "position",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "src",
          "type": "string"
        },
        {
          "name": "width",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "height",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "alt",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.InventoryLevel": {
      "fields": [
        {
          "name": "inventory_item_id",
          "type": "string"
        },
        {
          "name": "location_id",
          "type": "string"
        },
        {
          "name": "stock",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.VariantInventory": {
      "fields": [
        {
          "name": "variant_id",
          "type": "string"
        },
        {
          "name": "location_items",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202506.LocationItem"
          }
        }
      ]
    },
    "v202506.LocationItem": {
      "fields": [
        {
          "name": "location_id",
          "type": "integer",
          "format": "uint64"
        },
        {
          "name": "stock",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202506.InventoryItem": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "variant_id",
          "type": "string"
        },
        {
          "name": "tracking",
          "type": "boolean"
        },
        {
          "name": "tracking_policy",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.VariantInventoryItem": {
      "fields": [
        {
          "name": "inventory_item_id",
          "type": "string"
        },
        {
          "name": "variant_id",
          "type": "string"
        }
      ]
    },
    "v202506.Location": {
      "fields": [
        {
          "name": "id",
          "type": "integer",
          "format": "uint64"
        },
        {
          "name": "active",
          "type": "boolean"
        },
        {
          "name": "default",
          "type": "boolean"
        },
        {
          "name": "country",
          "type": "string"
        },
        {
          "name": "country_code",
          "type": "string"
        },
        {
          "name": "province",
          "type": "string"
        },
        {
          "name": "province_code",
          "type": "string"
        },
        {
          "name": "city",
          "type": "string"
        },
        {
          "name": "area",
          "type": "string"
        },
        {
          "name": "address",
          "type": "string"
        },
        {
          "name": "address1",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "phone",
          "type": "string"
        },
        {
          "name": "zip",
          "type": "string"
        },
        {
          "name": "company",
          "type": "string"
        },
        {
          "name": "latitude",
          "type": "string"
        },
        {
          "name": "longitude",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.CreateProcurementItemData": {
      "fields": [
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "variant_id",
          "type": "string"
        },
        {
          "name": "transfer_quantity",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202506.Procurement": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "procurement_sn",
          "type": "string"
        },
        {
          "name": "supplier_id",
          "type": "string"
        },
        {
          "name": "location_id",
          "type": "string"
        },
        {
          "name": "note",
          "type": "string"
        },
        {
          "name": "state",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "pending_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "received_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "rejected_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "transfer_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "created_by",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.ProcurementItem": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "procurement_id",
          "type": "string"
        },
        {
          "name": "pending_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "received_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "rejected_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "transfer_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "variant_id",
          "type": "string"
        },
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "product_title",
          "type": "string"
        },
        {
          "name": "variant_title",
          "type": "string"
        },
        {
          "name": "variant_sku",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "product_image",
          "type": "object",
          "schema": "v202506.Image"
        }
      ]
    },
    "v202506.Supplier": {
      "fields": [
        {
          "name": "id",
          "type": "integer",
          "format": "uint64"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "url",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.DataByLandPage": {
      "fields": [
        {
          "name": "last_referrer_show",
          "type": "string"
        },
        {
          "name": "land_url_path",
          "type": "string"
        },
        {
          "name": "last_template_name",
          "type": "string"
        },
        {
          "name": "last_template_name_original",
          "type": "string"
        },
        {
          "name": "pv",
          "type": "string"
        },
        {
          "name": "uv",
          "type": "string"
        },
        {
          "name": "conversion_rate",
          "type": "string"
        },
        {
          "name": "add_cart_uv",
          "type": "string"
        },
        {
          "name": "begin_checkout_uv",
          "type": "string"
        },
        {
          "name": "add_payment_info_uv",
          "type": "string"
        },
        {
          "name": "orders",
          "type": "string"
        },
        {
          "name": "sales",
          "type": "string"
        },
        {
          "name": "avg_elapse",
          "type": "string"
        },
        {
          "name": "escape_rate",
          "type": "string"
        },
        {
          "name": "pv_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "uv_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "conversion_rate_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "add_cart_uv_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "begin_checkout_uv_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_payment_info_uv_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "orders_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "sales_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "avg_elapse_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "escape_rate_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "last_referrer_first_show",
          "type": "string"
        },
        {
          "name": "product_uv",
          "type": "string"
        },
        {
          "name": "product_uv_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "order_customers",
          "type": "string"
        },
        {
          "name": "order_customers_original",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202506.DataBySku": {
      "fields": [
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "variant_id",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "brief",
          "type": "string"
        },
        {
          "name": "variant_title",
          "type": "string"
        },
        {
          "name": "sku",
          "type": "string"
        },
        {
          "name": "spu",
          "type": "string"
        },
        {
          "name": "image",
          "type": "string"
        },
        {
          "name": "seo_url",
          "type": "string"
        },
        {
          "name": "price",
          "type": "number",
          "format": "float"
        },
        {
          "name": "variant_op_updated_at",
          "type": "string"
        },
        {
          "name": "sales_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "sales_total",
          "type": "number",
          "format": "float"
        },
        {
          "name": "net_sales_total",
          "type": "number",
          "format": "float"
        },
        {
          "name": "order_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "refund_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "views_count_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "view_client_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_to_cart_count_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_cart_client_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "transform_rate_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "add_to_cart_conversion_rate_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "published_at",
          "type": "string"
        },
        {
          "name": "refund_quantity",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_to_cart_rate_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "views_rate_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "opened_orders",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "refund_orders",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "transform_rate",
          "type": "string"
        },
        {
          "name": "add_to_cart_conversion_rate",
          "type": "string"
        },
        {
          "name": "add_to_cart_rate",
          "type": "string"
        },
        {
          "name": "views_rate",
          "type": "string"
        },
        {
          "name": "views_count",
          "type": "string"
        },
        {
          "name": "add_to_cart_count",
          "type": "string"
        }
      ]
    },
    "v202506.DataBySpu": {
      "fields": [
        {
          "name": "utm_source",
          "type": "string"
        },
        {
          "name": "utm_medium",
          "type": "string"
        },
        {
          "name": "utm_campaign",
          "type": "string"
        },
        {
          "name": "utm_term",
          "type": "string"
        },
        {
          "name": "utm_content",
          "type": "string"
        },
        {
          "name": "image",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "order_count_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "sales_count_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "sales_total_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "net_sales_total_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "discount_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "tax_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "views_count_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_to_cart_count_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "views_rate_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "add_to_cart_rate_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "view_client_count_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_cart_client_count_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_to_cart_conversion_rate_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "transform_rate_original",
          "type": "number",
          "format": "float"
        },
        {
          "name": "product_id",
          "type": "string"
        },
        {
          "name": "brief",
          "type": "string"
        },
        {
          "name": "spu",
          "type": "string"
        },
        {
          "name": "collection",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "first_published_at",
          "type": "string"
        },
        {
          "name": "published_at",
          "type": "string"
        },
        {
          "name": "product_op_updated_at",
          "type": "string"
        },
        {
          "name": "published",
          "type": "boolean"
        },
        {
          "name": "duty_total_original",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "order_count",
          "type": "string"
        },
        {
          "name": "sales_count",
          "type": "string"
        },
        {
          "name": "sales_total",
          "type": "string"
        },
        {
          "name": "net_sales_total",
          "type": "string"
        },
        {
          "name": "discount",
          "type": "string"
        },
        {
          "name": "tax",
          "type": "string"
        },
        {
          "name": "views_count",
          "type": "string"
        },
        {
          "name": "add_to_cart_count",
          "type": "string"
        },
        {
          "name": "views_rate",
          "type": "string"
        },
        {
          "name": "add_to_cart_rate",
          "type": "string"
        },
        {
          "name": "view_client_count",
          "type": "string"
        },
        {
          "name": "add_cart_client_count",
          "type": "string"
        },
        {
          "name": "add_to_cart_conversion_rate",
          "type": "string"
        },
        {
          "name": "transform_rate",
          "type": "string"
        },
        {
          "name": "duty_total",
          "type": "string"
        },
        {
          "name": "seo_url",
          "type": "string"
        },
        {
          "name": "impression",
          "type": "string"
        },
        {
          "name": "collection_id",
          "type": "string"
        },
        {
          "name": "collection_title",
          "type": "string"
        },
        {
          "name": "impression_original",
          "type": "integer",
          "format": "int64"
        }
      ]
    },
    "v202506.DataByUTM": {
      "fields": [
        {
          "name": "date",
          "type": "string"
        },
        {
          "name": "utm_source",
          "type": "string"
        },
        {
          "name": "utm_medium",
          "type": "string"
        },
        {
          "name": "utm_campaign",
          "type": "string"
        },
        {
          "name": "utm_content",
          "type": "string"
        },
        {
          "name": "utm_term",
          "type": "string"
        },
        {
          "name": "country",
          "type": "string"
        },
        {
          "name": "country_abbr",
          "type": "string"
        },
        {
          "name": "land_url_path",
          "type": "string"
        },
        {
          "name": "page_views_total",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "view_client_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "uv_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "product_views_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_to_cart_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "begin_checkout_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "orders_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "orders_count_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "transform_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "product_sales",
          "type": "number",
          "format": "float"
        },
        {
          "name": "product_sales_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "per_customer_sales",
          "type": "number",
          "format": "float"
        },
        {
          "name": "avg_elapse",
          "type": "number",
          "format": "float"
        },
        {
          "name": "avg_depth",
          "type": "number",
          "format": "float"
        },
        {
          "name": "place_order_client_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "first_order_customers",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "first_order_customers_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "escape_rate",
          "type": "number",
          "format": "float"
        }
      ]
    },
    "v202506.UTMSummary": {
      "fields": [
        {
          "name": "page_views_total",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "view_client_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "uv_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "product_views_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_to_cart_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "begin_checkout_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "orders_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "orders_count_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "transform_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "product_sales",
          "type": "number",
          "format": "float"
        },
        {
          "name": "product_sales_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "per_customer_sales",
          "type": "number",
          "format": "float"
        },
        {
          "name": "avg_elapse",
          "type": "number",
          "format": "float"
        },
        {
          "name": "avg_depth",
          "type": "number",
          "format": "float"
        },
        {
          "name": "place_order_client_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "first_order_customers",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "first_order_customers_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "escape_rate",
          "type": "number",
          "format": "float"
        }
      ]
    },
    "v202506.DataAnalysis": {
      "fields": [
        {
          "name": "date_time",
          "type": "string"
        },
        {
          "name": "country_abbr",
          "type": "string"
        },
        {
          "name": "country_code",
          "type": "string"
        },
        {
          "name": "utm_source",
          "type": "string"
        },
        {
          "name": "utm_medium",
          "type": "string"
        },
        {
          "name": "utm_campaign",
          "type": "string"
        },
        {
          "name": "utm_term",
          "type": "string"
        },
        {
          "name": "utm_content",
          "type": "string"
        },
        {
          "name": "pv",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "uv",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_cart_uv",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_cart_qty",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "add_payment_info_uv",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "begin_checkout_pv",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "begin_checkout_uv",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "orders",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "sales",
          "type": "number",
          "format": "float"
        },
        {
          "name": "conversion_rate",
          "type": "number",
          "format": "float"
        },
        {
          "name": "impression",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202601.DataBySearchKeyword": {
      "fields": [
        {
          "name": "item",
          "type": "string"
        },
        {
          "name": "count",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "percent",
          "type": "number",
          "format": "double"
        },
        {
          "name": "uv",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "has_result",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "click_rate",
          "type": "number",
          "format": "double"
        }
      ]
    },
    "v202601.DataByTrafficChannel": {
      "fields": [
        {
          "name": "last_referrer_first_show",
          "type": "string"
        },
        {
          "name": "last_referrer_show",
          "type": "string"
        },
        {
          "name": "uv",
          "type": "string"
        },
        {
          "name": "uv_original",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "sales",
          "type": "string"
        },
        {
          "name": "sales_original",
          "type": "number",
          "format": "double"
        },
        {
          "name": "orders",
          "type": "string"
        },
        {
          "name": "orders_original",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "uv_rate",
          "type": "string"
        },
        {
          "name": "uv_rate_original",
          "type": "number",
          "format": "double"
        },
        {
          "name": "sales_rate",
          "type": "string"
        },
        {
          "name": "sales_rate_original",
          "type": "number",
          "format": "double"
        },
        {
          "name": "orders_rate",
          "type": "string"
        },
        {
          "name": "orders_rate_original",
          "type": "number",
          "format": "double"
        }
      ]
    },
    "v202601.TrafficChannelOption": {
      "fields": [
        {
          "name": "last_referrer_first_show",
          "type": "string"
        },
        {
          "name": "last_referrer_shows",
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ]
    },
    "v202506.Article": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "excerpt",
          "type": "string"
        },
        {
          "name": "content",
          "type": "string"
        },
        {
          "name": "image",
          "type": "object",
          "schema": "v202506.ArticleImage"
        },
        {
          "name": "published",
          "type": "boolean"
        },
        {
          "name": "handle",
          "type": "string"
        },
        {
          "name": "seo_title",
          "type": "string"
        },
        {
          "name": "seo_description",
          "type": "string"
        },
        {
          "name": "seo_keywords",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "author",
          "type": "string"
        },
        {
          "name": "published_at",
          "type": "string"
        },
        {
          "name": "blog_ids",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.ArticleImage": {
      "fields": [
        {
          "name": "src",
          "type": "string"
        },
        {
          "name": "width",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "height",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "path",
          "type": "string"
        }
      ]
    },
    "v202506.Blog": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "handle",
          "type": "string"
        },
        {
          "name": "seo_title",
          "type": "string"
        },
        {
          "name": "seo_description",
          "type": "string"
        },
        {
          "name": "seo_keywords",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202601.Blog": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "handle",
          "type": "string"
        },
        {
          "name": "seo_title",
          "type": "string"
        },
        {
          "name": "seo_description",
          "type": "string"
        },
        {
          "name": "seo_keywords",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "article_count",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202506.File": {
      "fields": [
        {
          "name": "upload_link",
          "type": "string"
        },
        {
          "name": "file_uri",
          "type": "string"
        },
        {
          "name": "folder",
          "type": "string"
        },
        {
          "name": "size",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "origin_link",
          "type": "string"
        },
        {
          "name": "desc",
          "type": "string"
        },
        {
          "name": "aspect_ratio",
          "type": "string"
        },
        {
          "name": "width",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "height",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.FileList": {
      "fields": [
        {
          "name": "file_uri",
          "type": "string"
        },
        {
          "name": "origin_link",
          "type": "string"
        },
        {
          "name": "upload_link",
          "type": "string"
        }
      ]
    },
    "v202506.Icon": {
      "fields": [
        {
          "name": "alt",
          "type": "string"
        },
        {
          "name": "path",
          "type": "string"
        },
        {
          "name": "src",
          "type": "string"
        }
      ]
    },
    "v202506.SubscriptionStatus": {
      "fields": [
        {
          "name": "type",
          "type": "string"
        }
      ]
    },
    "v202601.Language": {
      "fields": [
        {
          "name": "code",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "is_enabled",
          "type": "boolean"
        },
        {
          "name": "markets",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.LanguageMarket"
          }
        }
      ]
    },
    "v202601.LanguageMarket": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        }
      ]
    },
    "v202601.ConfigurableMarket": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "is_primary",
          "type": "boolean"
        },
        {
          "name": "market_status",
          "type": "string"
        },
        {
          "name": "language_manageable",
          "type": "boolean"
        }
      ]
    },
    "v202601.SupportedLanguage": {
      "fields": [
        {
          "name": "code",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        }
      ]
    },
    "v202601.Market": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "market_name",
          "type": "string"
        },
        {
          "name": "is_primary",
          "type": "boolean"
        },
        {
          "name": "is_default",
          "type": "boolean"
        },
        {
          "name": "market_status",
          "type": "string"
        },
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "symbol",
          "type": "object",
          "schema": "v202601.MarketCurrencySymbol"
        },
        {
          "name": "domain_type",
          "type": "string"
        },
        {
          "name": "domain_value",
          "type": "string"
        },
        {
          "name": "custom_rate_enabled",
          "type": "boolean"
        },
        {
          "name": "custom_exchange_rate",
          "type": "number",
          "format": "double"
        },
        {
          "name": "price_adjust",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "local_currency_enabled",
          "type": "boolean"
        },
        {
          "name": "product_tax_included",
          "type": "boolean"
        },
        {
          "name": "default_language",
          "type": "string"
        },
        {
          "name": "countries",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "languages",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.MarketLanguage"
          }
        },
        {
          "name": "language_manageable",
          "type": "boolean"
        },
        {
          "name": "url",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "actual_rate",
          "type": "number",
          "format": "double"
        },
        {
          "name": "exchange_rate",
          "type": "object",
          "schema": "v202601.MarketExchangeRate"
        },
        {
          "name": "back_exchange_rate",
          "type": "object",
          "schema": "v202601.MarketExchangeRate"
        },
        {
          "name": "setting",
          "type": "object",
          "schema": "v202601.MarketStorefrontSetting"
        },
        {
          "name": "delivery_country_limited",
          "type": "boolean"
        }
      ]
    },
    "v202601.MarketCurrencySymbol": {
      "fields": [
        {
          "name": "val",
          "type": "string"
        },
        {
          "name": "left",
          "type": "string"
        },
        {
          "name": "right",
          "type": "string"
        },
        {
          "name": "cn_name",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "code",
          "type": "string"
        }
      ]
    },
    "v202601.MarketLanguage": {
      "fields": [
        {
          "name": "code",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "is_enabled",
          "type": "boolean"
        },
        {
          "name": "url",
          "type": "string"
        },
        {
          "name": "is_default",
          "type": "boolean"
        }
      ]
    },
    "v202601.MarketExchangeRate": {
      "fields": [
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "to_currency",
          "type": "string"
        },
        {
          "name": "rate",
          "type": "number",
          "format": "double"
        },
        {
          "name": "last_updated_at",
          "type": "string"
        }
      ]
    },
    "v202601.MarketStorefrontSetting": {
      "fields": [
        {
          "name": "redirect_enabled",
          "type": "boolean"
        },
        {
          "name": "price_round_enabled",
          "type": "boolean"
        },
        {
          "name": "geolocation_app_installed",
          "type": "boolean"
        },
        {
          "name": "language_selector_enabled",
          "type": "boolean"
        }
      ]
    },
    "v202601.MarketListItem": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "is_primary",
          "type": "boolean"
        },
        {
          "name": "is_default",
          "type": "boolean"
        },
        {
          "name": "market_status",
          "type": "string"
        },
        {
          "name": "countries",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "symbol",
          "type": "object",
          "schema": "v202601.MarketCurrencySymbol"
        },
        {
          "name": "local_currency_enabled",
          "type": "boolean"
        },
        {
          "name": "countries_detail",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.MarketCountryCurrencyDetail"
          }
        }
      ]
    },
    "v202601.MarketCountryCurrencyDetail": {
      "fields": [
        {
          "name": "country_code",
          "type": "string"
        },
        {
          "name": "currency",
          "type": "string"
        },
        {
          "name": "symbol",
          "type": "object",
          "schema": "v202601.MarketCurrencySymbol"
        },
        {
          "name": "detail",
          "type": "object",
          "schema": "v202601.MarketCountry"
        }
      ]
    },
    "v202601.MarketCountry": {
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "cn_name",
          "type": "string"
        },
        {
          "name": "continent",
          "type": "string"
        },
        {
          "name": "flag",
          "type": "string"
        },
        {
          "name": "iso_code_2",
          "type": "string"
        },
        {
          "name": "iso_code_3",
          "type": "string"
        }
      ]
    },
    "v202601.MarketProduct": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "price_min",
          "type": "string"
        },
        {
          "name": "price_max",
          "type": "string"
        },
        {
          "name": "image",
          "type": "object",
          "schema": "v202601.MarketProductImage"
        },
        {
          "name": "is_excluded",
          "type": "boolean"
        },
        {
          "name": "total_fixed_price",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "total_variants",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202601.MarketProductImage": {
      "fields": [
        {
          "name": "src",
          "type": "string"
        },
        {
          "name": "alt",
          "type": "string"
        },
        {
          "name": "width",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "height",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "path",
          "type": "string"
        }
      ]
    },
    "v202601.MarketDeletionItem": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        }
      ]
    },
    "v202506.DefinitionCount": {
      "fields": [
        {
          "name": "metafield_count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "definition_id",
          "type": "integer",
          "format": "uint64"
        }
      ]
    },
    "v202506.DefinitionCountByGroup": {
      "fields": [
        {
          "name": "count",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "owner_resource",
          "type": "string"
        }
      ]
    },
    "v202506.MetafieldDefinition": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "key",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "namespace",
          "type": "string"
        },
        {
          "name": "owner_resource",
          "type": "string"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "description",
          "type": "string"
        },
        {
          "name": "create_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.ResourceMetafield": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "store_id",
          "type": "integer",
          "format": "uint32"
        },
        {
          "name": "owner_resource",
          "type": "string"
        },
        {
          "name": "owner_id",
          "type": "string"
        },
        {
          "name": "namespace",
          "type": "string"
        },
        {
          "name": "key",
          "type": "string"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "value",
          "type": "object",
          "schema": "google.protobuf.Value"
        },
        {
          "name": "description",
          "type": "string"
        },
        {
          "name": "definition_id",
          "type": "integer",
          "format": "uint64"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.Metafield": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "store_id",
          "type": "integer",
          "format": "uint32"
        },
        {
          "name": "owner_resource",
          "type": "string"
        },
        {
          "name": "owner_id",
          "type": "string"
        },
        {
          "name": "namespace",
          "type": "string"
        },
        {
          "name": "key",
          "type": "string"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "value",
          "type": "object",
          "schema": "google.protobuf.Value"
        },
        {
          "name": "description",
          "type": "string"
        },
        {
          "name": "definition_id",
          "type": "integer",
          "format": "uint64"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.DeleteMetafield": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "store_id",
          "type": "integer",
          "format": "uint32"
        },
        {
          "name": "owner_resource",
          "type": "string"
        },
        {
          "name": "owner_id",
          "type": "string"
        },
        {
          "name": "namespace",
          "type": "string"
        },
        {
          "name": "key",
          "type": "string"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "value",
          "type": "object",
          "schema": "google.protobuf.Value"
        },
        {
          "name": "description",
          "type": "string"
        },
        {
          "name": "definition_id",
          "type": "integer",
          "format": "uint64"
        }
      ]
    },
    "v202506.CustomPage": {
      "fields": [
        {
          "name": "id",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "store_id",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "content",
          "type": "string"
        },
        {
          "name": "status",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "url",
          "type": "string"
        },
        {
          "name": "meta_title",
          "type": "string"
        },
        {
          "name": "meta_keywords",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "meta_description",
          "type": "string"
        },
        {
          "name": "independent_seo",
          "type": "boolean"
        },
        {
          "name": "origin",
          "type": "string"
        }
      ]
    },
    "v202506.UrlRedirect": {
      "fields": [
        {
          "name": "id",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "store_id",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "from_url",
          "type": "string"
        },
        {
          "name": "redirect_url",
          "type": "string"
        }
      ]
    },
    "v202601.ThemeExtensionApp": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "blocks",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "google.protobuf.Struct"
          }
        }
      ]
    },
    "v202601.ScriptTagGroup": {
      "fields": [
        {
          "name": "app_info",
          "type": "object",
          "schema": "v202601.ScriptTagAppInfo"
        },
        {
          "name": "script_tags",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "v202601.ScriptTagInfo"
          }
        }
      ]
    },
    "v202601.ScriptTagAppInfo": {
      "fields": [
        {
          "name": "id",
          "type": "integer",
          "format": "int64"
        },
        {
          "name": "icon",
          "type": "string"
        },
        {
          "name": "uid",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "link",
          "type": "string"
        },
        {
          "name": "subtitle",
          "type": "string"
        },
        {
          "name": "installed_at",
          "type": "string"
        }
      ]
    },
    "v202601.ScriptTagInfo": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "app_id",
          "type": "string"
        },
        {
          "name": "source",
          "type": "string"
        },
        {
          "name": "device",
          "type": "string"
        },
        {
          "name": "display_scope",
          "type": "string"
        },
        {
          "name": "event_type",
          "type": "string"
        },
        {
          "name": "src",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "position",
          "type": "string"
        },
        {
          "name": "store_id",
          "type": "string"
        },
        {
          "name": "store_domain",
          "type": "string"
        },
        {
          "name": "event_period",
          "type": "string"
        },
        {
          "name": "env",
          "type": "string"
        },
        {
          "name": "exclude_ids",
          "type": "string"
        },
        {
          "name": "weight",
          "type": "string"
        },
        {
          "name": "started_at",
          "type": "string"
        },
        {
          "name": "ended_at",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202601.GenBlockDoc": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "location",
          "type": "string"
        },
        {
          "name": "hash",
          "type": "string"
        },
        {
          "name": "content",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202601.PublicBlockApp": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "blocks",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "google.protobuf.Struct"
          }
        }
      ]
    },
    "v202506.ThemeFile": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "theme_id",
          "type": "string"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "location",
          "type": "string"
        },
        {
          "name": "remote_url",
          "type": "string"
        },
        {
          "name": "content",
          "type": "string"
        }
      ]
    },
    "v202506.ThemeDocLocation": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "location",
          "type": "string"
        }
      ]
    },
    "v202506.Theme": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "merchant_theme_id",
          "type": "string"
        },
        {
          "name": "merchant_theme_name",
          "type": "string"
        },
        {
          "name": "merchant_theme_info",
          "type": "string"
        },
        {
          "name": "locale",
          "type": "string"
        },
        {
          "name": "preset",
          "type": "string"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "desc",
          "type": "string"
        },
        {
          "name": "default",
          "type": "string"
        },
        {
          "name": "pc_cover_url",
          "type": "string"
        },
        {
          "name": "mobile_cover_url",
          "type": "string"
        },
        {
          "name": "published",
          "type": "string"
        },
        {
          "name": "is_auto_upgrade",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "publish_time",
          "type": "string"
        },
        {
          "name": "auto_save_time",
          "type": "string"
        },
        {
          "name": "theme_save_time",
          "type": "string"
        },
        {
          "name": "version",
          "type": "string"
        },
        {
          "name": "c_version",
          "type": "string"
        },
        {
          "name": "change_log",
          "type": "string"
        },
        {
          "name": "version_publish_time",
          "type": "string"
        },
        {
          "name": "newest_c_version",
          "type": "string"
        },
        {
          "name": "has_newest_version",
          "type": "boolean"
        },
        {
          "name": "has_draft",
          "type": "boolean"
        },
        {
          "name": "theme_version_id",
          "type": "string"
        }
      ]
    },
    "v202601.MerchantTheme": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "remote_theme_id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "category",
          "type": "string"
        },
        {
          "name": "desc",
          "type": "string"
        },
        {
          "name": "preset_name",
          "type": "string"
        },
        {
          "name": "c_version",
          "type": "string"
        },
        {
          "name": "version_publish_time",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "default",
          "type": "string"
        },
        {
          "name": "is_paid",
          "type": "boolean"
        },
        {
          "name": "pc_cover_url",
          "type": "string"
        },
        {
          "name": "mobile_cover_url",
          "type": "string"
        },
        {
          "name": "preview_url",
          "type": "string"
        },
        {
          "name": "change_log",
          "type": "string"
        },
        {
          "name": "exts",
          "type": "string"
        },
        {
          "name": "preset_data",
          "type": "object",
          "schema": "google.protobuf.Struct"
        },
        {
          "name": "presets",
          "type": "object",
          "schema": "google.protobuf.Struct"
        },
        {
          "name": "price",
          "type": "object",
          "schema": "google.protobuf.ListValue"
        }
      ]
    },
    "v202506.PublishThemeData": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "merchant_theme_id",
          "type": "string"
        },
        {
          "name": "locale",
          "type": "string"
        },
        {
          "name": "preset",
          "type": "string"
        },
        {
          "name": "published",
          "type": "string"
        },
        {
          "name": "status",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "publish_time",
          "type": "string"
        },
        {
          "name": "theme_save_time",
          "type": "string"
        },
        {
          "name": "theme_version_id",
          "type": "string"
        },
        {
          "name": "revoke_publish_id",
          "type": "string"
        }
      ]
    },
    "v202601.Card": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "source",
          "type": "string"
        },
        {
          "name": "name",
          "type": "object",
          "schema": "google.protobuf.Value"
        },
        {
          "name": "category",
          "type": "string"
        },
        {
          "name": "second_category",
          "type": "string"
        },
        {
          "name": "description",
          "type": "string"
        },
        {
          "name": "preview_image",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "templates",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "name": "limit",
          "type": "integer",
          "format": "int32"
        }
      ]
    },
    "v202601.ThemeOperationResult": {
      "fields": [
        {
          "name": "op",
          "type": "string"
        },
        {
          "name": "result",
          "type": "string"
        }
      ]
    },
    "v202601.CardGroup": {
      "fields": [
        {
          "name": "group_key",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "group_name",
          "type": "string"
        },
        {
          "name": "groups",
          "type": "array",
          "items": {
            "type": "object",
            "schema": "google.protobuf.Struct"
          }
        }
      ]
    },
    "v202601.EditSessionFile": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "theme_id",
          "type": "string"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "location",
          "type": "string"
        },
        {
          "name": "content",
          "type": "string"
        },
        {
          "name": "oseid",
          "type": "string"
        }
      ]
    },
    "v202506.Task": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "store_id",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "status",
          "type": "integer",
          "format": "int32"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "info",
          "type": "string"
        },
        {
          "name": "message",
          "type": "string"
        },
        {
          "name": "manifest",
          "type": "string"
        }
      ]
    },
    "v202601.ThemeTemplate": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "theme_id",
          "type": "string"
        },
        {
          "name": "store_id",
          "type": "string"
        },
        {
          "name": "doc_id",
          "type": "string"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "suffix",
          "type": "string"
        },
        {
          "name": "from",
          "type": "string"
        },
        {
          "name": "obj_id",
          "type": "string"
        },
        {
          "name": "obj_title",
          "type": "string"
        },
        {
          "name": "source",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "icon",
          "type": "string"
        },
        {
          "name": "count",
          "type": "string"
        }
      ]
    },
    "v202506.ThemeFileVersion": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "version",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "theme_id",
          "type": "string"
        },
        {
          "name": "type",
          "type": "string"
        },
        {
          "name": "location",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.CarrierService": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "active",
          "type": "boolean"
        },
        {
          "name": "callback_url",
          "type": "string"
        },
        {
          "name": "scopes",
          "type": "string"
        },
        {
          "name": "carrier_service_code",
          "type": "string"
        },
        {
          "name": "logo",
          "type": "string"
        },
        {
          "name": "short_desc",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        }
      ]
    },
    "v202506.WebhookParam": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "address",
          "type": "string"
        },
        {
          "name": "topic",
          "type": "string"
        },
        {
          "name": "created_at",
          "type": "string"
        },
        {
          "name": "updated_at",
          "type": "string"
        },
        {
          "name": "format",
          "type": "string"
        }
      ]
    }
  },
  "exclusions": [
    {
      "id": "one-time-application-charge-create",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "one-time-application-charge-detail",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "one-time-application-charges",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "one-time-application-charge-transactions",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "recurring-application-charge-cancel",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "recurring-application-charge-create",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "recurring-application-charge-detail",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "recurring-application-charges",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "recurring-application-charge-transactions",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "recurring-application-charge-update",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "app-charge-transaction-detail",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "usage-charge-create",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "usage-charge-detail",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    },
    {
      "id": "usage-charges",
      "category": "deferred_integration",
      "reason": "App billing is a separate app-developer charging workflow."
    }
  ]
};
