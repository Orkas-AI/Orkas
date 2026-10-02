'use strict';
// Generated offline from pinned official current-grant merchant models.
module.exports = {
  "documentation_snapshot": "2026-10-01",
  "methods": {
    "GET /sell/account/v1/custom_policy/": {
      "operation": "getCustomPolicies",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/custom_policy/",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves the list of custom policies defined for a seller's account. To limit the returned custom policies, specify the policy_types query parameter. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "policy_types": {
                "type": "string",
                "description": "This query parameter specifies the type of custom policies to be returned. Multiple policy types may be requested in a single call by providing a comma-delimited set of all policy types to be returned. Note: Omitting this query parameter from a request will also return policies of all policy types. See the CustomPolicyTypeEnum type for a list of supported values.",
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
          "name": "policy_types",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__CustomPolicyResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__CustomPolicyResponse",
        "account__CompactCustomPolicyResponse"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v1/custom_policy/": {
      "operation": "createCustomPolicy",
      "family": "account",
      "method": "POST",
      "path": "/sell/account/v1/custom_policy/",
      "risk": "W",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method creates a new custom policy that specifies the seller's terms for complying with local governmental regulations. Each Custom Policy targets a policyType . Multiple policies may b Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account__CustomPolicyCreateRequest"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "account__CustomPolicyCreateRequest"
      ],
      "wire": [],
      "responses": {
        "201": {
          "schema": {
            "type": "object",
            "additionalProperties": true
          },
          "location": true
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/custom_policy/{custom_policy_id}": {
      "operation": "getCustomPolicy",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/custom_policy/{custom_policy_id}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves the custom policy specified by the custom_policy_id path parameter. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "custom_policy_id": {
                "type": "string",
                "description": "This path parameter is the unique identifier of the custom policy to retrieve. This ID can be retrieved for a custom policy by using the getCustomPolicies method.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "custom_policy_id"
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
          "name": "custom_policy_id",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__CustomPolicy"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__CustomPolicy"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "PUT /sell/account/v1/custom_policy/{custom_policy_id}": {
      "operation": "updateCustomPolicy",
      "family": "account",
      "method": "PUT",
      "path": "/sell/account/v1/custom_policy/{custom_policy_id}",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method updates an existing custom policy specified by the custom_policy_id path parameter. Since this method overwrites the policy's name , label , and description fields, always includ Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "custom_policy_id": {
                "type": "string",
                "description": "This path parameter is the unique identifier of the custom policy to update. Note: A list of custom policies defined for a seller's account that includes this ID can be retrieved by calling the getCustomPolicies method.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "custom_policy_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/account__CustomPolicyRequest"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "account__CustomPolicyRequest"
      ],
      "wire": [
        {
          "location": "path",
          "name": "custom_policy_id",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v1/fulfillment_policy/": {
      "operation": "createFulfillmentPolicy",
      "family": "account",
      "method": "POST",
      "path": "/sell/account/v1/fulfillment_policy/",
      "risk": "W",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method creates a new fulfillment policy for an eBay marketplace where the policy encapsulates seller's terms for fulfilling item purchases. Fulfillment policies include the shipment opt Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account__FulfillmentPolicyRequest"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "account__FulfillmentPolicyRequest",
        "account__CategoryType",
        "account__TimeDuration",
        "account__ShippingOption",
        "account__Amount",
        "account__ShippingService",
        "account__RegionSet",
        "account__Region"
      ],
      "wire": [],
      "responses": {
        "201": {
          "schema": {
            "$ref": "#/$defs/account__SetFulfillmentPolicyResponse"
          },
          "location": true
        }
      },
      "response_definitions": [
        "account__SetFulfillmentPolicyResponse",
        "account__CategoryType",
        "account__TimeDuration",
        "account__ShippingOption",
        "account__Amount",
        "account__ShippingService",
        "account__RegionSet",
        "account__Region",
        "account__Error",
        "account__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "GET /sell/account/v1/fulfillment_policy/{fulfillmentPolicyId}": {
      "operation": "getFulfillmentPolicy",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/fulfillment_policy/{fulfillmentPolicyId}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves the complete details of a fulfillment policy. Supply the ID of the policy you want to retrieve using the fulfillmentPolicyId path parameter. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "fulfillmentPolicyId": {
                "type": "string",
                "description": "This path parameter specifies the ID of the fulfillment policy you want to retrieve. This ID can be retrieved for a fulfillment policy by using the getFulfillmentPolicies method.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "fulfillmentPolicyId"
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
          "name": "fulfillmentPolicyId",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__FulfillmentPolicy"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__FulfillmentPolicy",
        "account__CategoryType",
        "account__TimeDuration",
        "account__ShippingOption",
        "account__Amount",
        "account__ShippingService",
        "account__RegionSet",
        "account__Region"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "PUT /sell/account/v1/fulfillment_policy/{fulfillmentPolicyId}": {
      "operation": "updateFulfillmentPolicy",
      "family": "account",
      "method": "PUT",
      "path": "/sell/account/v1/fulfillment_policy/{fulfillmentPolicyId}",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method updates an existing fulfillment policy. Specify the policy you want to update using the fulfillment_policy_id path parameter. Supply a complete policy payload with the updates yo Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "fulfillmentPolicyId": {
                "type": "string",
                "description": "This path parameter specifies the ID of the fulfillment policy you want to update. This ID can be retrieved for a specific fulfillment policy by using the getFulfillmentPolicies method.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "fulfillmentPolicyId"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/account__FulfillmentPolicyRequest"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "account__FulfillmentPolicyRequest",
        "account__CategoryType",
        "account__TimeDuration",
        "account__ShippingOption",
        "account__Amount",
        "account__ShippingService",
        "account__RegionSet",
        "account__Region"
      ],
      "wire": [
        {
          "location": "path",
          "name": "fulfillmentPolicyId",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__SetFulfillmentPolicyResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__SetFulfillmentPolicyResponse",
        "account__CategoryType",
        "account__TimeDuration",
        "account__ShippingOption",
        "account__Amount",
        "account__ShippingService",
        "account__RegionSet",
        "account__Region",
        "account__Error",
        "account__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "DELETE /sell/account/v1/fulfillment_policy/{fulfillmentPolicyId}": {
      "operation": "deleteFulfillmentPolicy",
      "family": "account",
      "method": "DELETE",
      "path": "/sell/account/v1/fulfillment_policy/{fulfillmentPolicyId}",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method deletes a fulfillment policy. Supply the ID of the policy you want to delete in the fulfillmentPolicyId path parameter. Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "fulfillmentPolicyId": {
                "type": "string",
                "description": "This path parameter specifies the ID of the fulfillment policy to delete. This ID can be retrieved for a fulfillment policy by using the getFulfillmentPolicies method.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "fulfillmentPolicyId"
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
          "name": "fulfillmentPolicyId",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/fulfillment_policy": {
      "operation": "getFulfillmentPolicies",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/fulfillment_policy",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves all the fulfillment policies configured for the marketplace you specify using the marketplace_id query parameter. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "marketplace_id": {
                "type": "string",
                "description": "This query parameter specifies the eBay marketplace of the policies you want to retrieve. For implementation help, refer to eBay API documentation at https://developer.ebay.com/api-docs/sell/account/types/ba:MarketplaceIdEnum",
                "maxLength": 262144
              }
            },
            "required": [
              "marketplace_id"
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
          "name": "marketplace_id",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__FulfillmentPolicyResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__FulfillmentPolicyResponse",
        "account__FulfillmentPolicy",
        "account__CategoryType",
        "account__TimeDuration",
        "account__ShippingOption",
        "account__Amount",
        "account__ShippingService",
        "account__RegionSet",
        "account__Region"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/fulfillment_policy/get_by_policy_name": {
      "operation": "getFulfillmentPolicyByName",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/fulfillment_policy/get_by_policy_name",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves the details for a specific fulfillment policy. In the request, supply both the policy name and its associated marketplace_id as query parameters. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "marketplace_id": {
                "type": "string",
                "description": "This query parameter specifies the eBay marketplace of the policy you want to retrieve. For implementation help, refer to eBay API documentation at https://developer.ebay.com/api-docs/sell/account/types/ba:MarketplaceIdEnum",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "description": "This query parameter specifies the seller-defined name of the fulfillment policy you want to retrieve. This value can be retrieved for a fulfillment policy by using the getFulfillmentPolicies method.",
                "maxLength": 262144
              }
            },
            "required": [
              "marketplace_id",
              "name"
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
          "name": "marketplace_id",
          "explode": true
        },
        {
          "location": "query",
          "name": "name",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__FulfillmentPolicy"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__FulfillmentPolicy",
        "account__CategoryType",
        "account__TimeDuration",
        "account__ShippingOption",
        "account__Amount",
        "account__ShippingService",
        "account__RegionSet",
        "account__Region"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/payment_policy": {
      "operation": "getPaymentPolicies",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/payment_policy",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves all the payment business policies configured for the marketplace you specify using the marketplace_id query parameter. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "marketplace_id": {
                "type": "string",
                "description": "This query parameter specifies the eBay marketplace of the policies you want to retrieve. For implementation help, refer to eBay API documentation at https://developer.ebay.com/api-docs/sell/account/types/ba:MarketplaceIdEnum",
                "maxLength": 262144
              }
            },
            "required": [
              "marketplace_id"
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
          "name": "marketplace_id",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__PaymentPolicyResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__PaymentPolicyResponse",
        "account__PaymentPolicy",
        "account__CategoryType",
        "account__Deposit",
        "account__Amount",
        "account__TimeDuration",
        "account__PaymentMethod",
        "account__RecipientAccountReference"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v1/payment_policy": {
      "operation": "createPaymentPolicy",
      "family": "account",
      "method": "POST",
      "path": "/sell/account/v1/payment_policy",
      "risk": "W",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method creates a new payment policy where the policy encapsulates seller's terms for order payments. A successful request returns the getPaymentPolicy URI to the new policy in the Locat Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account__PaymentPolicyRequest"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "account__PaymentPolicyRequest",
        "account__CategoryType",
        "account__Deposit",
        "account__Amount",
        "account__TimeDuration",
        "account__PaymentMethod",
        "account__RecipientAccountReference"
      ],
      "wire": [],
      "responses": {
        "201": {
          "schema": {
            "$ref": "#/$defs/account__SetPaymentPolicyResponse"
          },
          "location": true
        }
      },
      "response_definitions": [
        "account__SetPaymentPolicyResponse",
        "account__CategoryType",
        "account__Deposit",
        "account__Amount",
        "account__TimeDuration",
        "account__PaymentMethod",
        "account__RecipientAccountReference",
        "account__Error",
        "account__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "GET /sell/account/v1/payment_policy/{payment_policy_id}": {
      "operation": "getPaymentPolicy",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/payment_policy/{payment_policy_id}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves the complete details of a payment policy. Supply the ID of the policy you want to retrieve using the paymentPolicyId path parameter. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "payment_policy_id": {
                "type": "string",
                "description": "This path parameter specifies the ID of the payment policy you want to retrieve. This ID can be retrieved for a payment policy by using the getPaymentPolices method.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "payment_policy_id"
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
          "name": "payment_policy_id",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__PaymentPolicy"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__PaymentPolicy",
        "account__CategoryType",
        "account__Deposit",
        "account__Amount",
        "account__TimeDuration",
        "account__PaymentMethod",
        "account__RecipientAccountReference"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "PUT /sell/account/v1/payment_policy/{payment_policy_id}": {
      "operation": "updatePaymentPolicy",
      "family": "account",
      "method": "PUT",
      "path": "/sell/account/v1/payment_policy/{payment_policy_id}",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method updates an existing payment policy. Specify the policy you want to update using the payment_policy_id path parameter. Supply a complete policy payload with the updates you want t Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "payment_policy_id": {
                "type": "string",
                "description": "This path parameter specifies the ID of the payment policy you want to update. This ID can be retrieved for a payment policy by using the getPaymentPolices method.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "payment_policy_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/account__PaymentPolicyRequest"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "account__PaymentPolicyRequest",
        "account__CategoryType",
        "account__Deposit",
        "account__Amount",
        "account__TimeDuration",
        "account__PaymentMethod",
        "account__RecipientAccountReference"
      ],
      "wire": [
        {
          "location": "path",
          "name": "payment_policy_id",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__SetPaymentPolicyResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__SetPaymentPolicyResponse",
        "account__CategoryType",
        "account__Deposit",
        "account__Amount",
        "account__TimeDuration",
        "account__PaymentMethod",
        "account__RecipientAccountReference",
        "account__Error",
        "account__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "DELETE /sell/account/v1/payment_policy/{payment_policy_id}": {
      "operation": "deletePaymentPolicy",
      "family": "account",
      "method": "DELETE",
      "path": "/sell/account/v1/payment_policy/{payment_policy_id}",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method deletes a payment policy. Supply the ID of the policy you want to delete in the paymentPolicyId path parameter. Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "payment_policy_id": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the payment policy you want to delete. This ID can be retrieved for a payment policy by using the getPaymentPolices method.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "payment_policy_id"
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
          "name": "payment_policy_id",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/payment_policy/get_by_policy_name": {
      "operation": "getPaymentPolicyByName",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/payment_policy/get_by_policy_name",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves the details of a specific payment policy. Supply both the policy name and its associated marketplace_id in the request query parameters. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "marketplace_id": {
                "type": "string",
                "description": "This query parameter specifies the eBay marketplace of the policy you want to retrieve. For implementation help, refer to eBay API documentation at https://developer.ebay.com/api-docs/sell/account/types/ba:MarketplaceIdEnum",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "description": "This query parameter specifies the seller-defined name of the payment policy you want to retrieve. This value can be retrieved for a payment policy by using the getPaymentPolicies method.",
                "maxLength": 262144
              }
            },
            "required": [
              "marketplace_id",
              "name"
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
          "name": "marketplace_id",
          "explode": true
        },
        {
          "location": "query",
          "name": "name",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__PaymentPolicy"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__PaymentPolicy",
        "account__CategoryType",
        "account__Deposit",
        "account__Amount",
        "account__TimeDuration",
        "account__PaymentMethod",
        "account__RecipientAccountReference"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/payments_program/{marketplace_id}/{payments_program_type}": {
      "operation": "getPaymentsProgram",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/payments_program/{marketplace_id}/{payments_program_type}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "Note: This method is no longer applicable, as all seller accounts globally have been enabled for the new eBay payment and checkout flow. This method returns whether or not the user is opted- One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "marketplace_id": {
                "type": "string",
                "description": "This path parameter specifies the eBay marketplace of the payments program for which you want to retrieve the seller's status.",
                "maxLength": 262144,
                "minLength": 1
              },
              "payments_program_type": {
                "type": "string",
                "description": "This path parameter specifies the payments program whose status is returned by the call.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "marketplace_id",
              "payments_program_type"
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
          "name": "marketplace_id",
          "explode": true
        },
        {
          "location": "path",
          "name": "payments_program_type",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__PaymentsProgramResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__PaymentsProgramResponse"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/payments_program/{marketplace_id}/{payments_program_type}/onboarding": {
      "operation": "getPaymentsProgramOnboarding",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/payments_program/{marketplace_id}/{payments_program_type}/onboarding",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "Note: This method is no longer applicable, as all seller accounts globally have been enabled for the new eBay payment and checkout flow. This method retrieves a seller's onboarding status fo One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "marketplace_id": {
                "type": "string",
                "description": "The eBay marketplace ID associated with the onboarding status to retrieve.",
                "maxLength": 262144,
                "minLength": 1
              },
              "payments_program_type": {
                "type": "string",
                "description": "The type of payments program whose status is returned by the method.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "marketplace_id",
              "payments_program_type"
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
          "name": "marketplace_id",
          "explode": true
        },
        {
          "location": "path",
          "name": "payments_program_type",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__PaymentsProgramOnboardingResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__PaymentsProgramOnboardingResponse",
        "account__PaymentsProgramOnboardingSteps"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/privilege": {
      "operation": "getPrivileges",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/privilege",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves the seller's current set of privileges, including whether or not the seller's eBay registration has been completed, as well as the details of their site-wide sellingLim One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__SellingPrivileges"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__SellingPrivileges",
        "account__SellingLimit",
        "account__Amount"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/program/get_opted_in_programs": {
      "operation": "getOptedInPrograms",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/program/get_opted_in_programs",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method gets a list of the seller programs that the seller has opted-in to. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__Programs"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__Programs",
        "account__Program"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/rate_table": {
      "operation": "getRateTables",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/rate_table",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves a seller's shipping rate tables for the country specified in the country_code query parameter. If you call this method without specifying a country code, the call retur One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "country_code": {
                "type": "string",
                "description": "This query parameter specifies the two-letter ISO 3166 code of country for which you want shipping rate table information. If you do not specify a country code, the request returns all of the seller's defined shipping rate tables for all eBay marketplaces. For implementation help, refer to eBay API documentation at https://developer.ebay.com/api-docs/sell/account/types/ba:CountryCodeEnum",
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
          "name": "country_code",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__RateTableResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__RateTableResponse",
        "account__RateTable"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/return_policy": {
      "operation": "getReturnPolicies",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/return_policy",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves all the return policies configured for the marketplace you specify using the marketplace_id query parameter. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "marketplace_id": {
                "type": "string",
                "description": "This query parameter specifies the ID of the eBay marketplace of the policies you want to retrieve. For implementation help, refer to eBay API documentation at https://developer.ebay.com/api-docs/sell/account/types/ba:MarketplaceIdEnum",
                "maxLength": 262144
              }
            },
            "required": [
              "marketplace_id"
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
          "name": "marketplace_id",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__ReturnPolicyResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__ReturnPolicyResponse",
        "account__ReturnPolicy",
        "account__CategoryType",
        "account__InternationalReturnOverrideType",
        "account__TimeDuration"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v1/return_policy": {
      "operation": "createReturnPolicy",
      "family": "account",
      "method": "POST",
      "path": "/sell/account/v1/return_policy",
      "risk": "W",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method creates a new return policy where the policy encapsulates seller's terms for returning items. Each policy targets a specific marketplace, and you can create multiple policies for Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account__ReturnPolicyRequest"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "account__ReturnPolicyRequest",
        "account__CategoryType",
        "account__InternationalReturnOverrideType",
        "account__TimeDuration"
      ],
      "wire": [],
      "responses": {
        "201": {
          "schema": {
            "$ref": "#/$defs/account__SetReturnPolicyResponse"
          },
          "location": true
        }
      },
      "response_definitions": [
        "account__SetReturnPolicyResponse",
        "account__CategoryType",
        "account__InternationalReturnOverrideType",
        "account__TimeDuration",
        "account__Error",
        "account__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "GET /sell/account/v1/return_policy/{return_policy_id}": {
      "operation": "getReturnPolicy",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/return_policy/{return_policy_id}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves the complete details of the return policy specified by the returnPolicyId path parameter. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "return_policy_id": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the return policy you want to retrieve. This ID can be retrieved for a return policy by using the getReturnPolicies method.",
                "maxLength": 262144,
                "minLength": 1
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
          "name": "return_policy_id",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__ReturnPolicy"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__ReturnPolicy",
        "account__CategoryType",
        "account__InternationalReturnOverrideType",
        "account__TimeDuration"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "PUT /sell/account/v1/return_policy/{return_policy_id}": {
      "operation": "updateReturnPolicy",
      "family": "account",
      "method": "PUT",
      "path": "/sell/account/v1/return_policy/{return_policy_id}",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method updates an existing return policy. Specify the policy you want to update using the return_policy_id path parameter. Supply a complete policy payload with the updates you want to  Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "return_policy_id": {
                "type": "string",
                "description": "This path parameter specifies the ID of the return policy you want to update. This ID can be retrieved for a return policy by using the getReturnPolicies method.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "return_policy_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/account__ReturnPolicyRequest"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "account__ReturnPolicyRequest",
        "account__CategoryType",
        "account__InternationalReturnOverrideType",
        "account__TimeDuration"
      ],
      "wire": [
        {
          "location": "path",
          "name": "return_policy_id",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__SetReturnPolicyResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__SetReturnPolicyResponse",
        "account__CategoryType",
        "account__InternationalReturnOverrideType",
        "account__TimeDuration",
        "account__Error",
        "account__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "DELETE /sell/account/v1/return_policy/{return_policy_id}": {
      "operation": "deleteReturnPolicy",
      "family": "account",
      "method": "DELETE",
      "path": "/sell/account/v1/return_policy/{return_policy_id}",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method deletes a return policy. Supply the ID of the policy you want to delete in the returnPolicyId path parameter. Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "return_policy_id": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the return policy you want to delete. This ID can be retrieved for a return policy by using the getReturnPolicies method.",
                "maxLength": 262144,
                "minLength": 1
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
          "name": "return_policy_id",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/return_policy/get_by_policy_name": {
      "operation": "getReturnPolicyByName",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/return_policy/get_by_policy_name",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves the details of a specific return policy. Supply both the policy name and its associated marketplace_id in the request query parameters. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "marketplace_id": {
                "type": "string",
                "description": "This query parameter specifies the ID of the eBay marketplace of the policy you want to retrieve. For implementation help, refer to eBay API documentation at https://developer.ebay.com/api-docs/sell/account/types/ba:MarketplaceIdEnum",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "description": "This query parameter specifies the seller-defined name of the return policy you want to retrieve. This value can be retrieved for a return policy by using the getReturnPolicies method.",
                "maxLength": 262144
              }
            },
            "required": [
              "marketplace_id",
              "name"
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
          "name": "marketplace_id",
          "explode": true
        },
        {
          "location": "query",
          "name": "name",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__ReturnPolicy"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__ReturnPolicy",
        "account__CategoryType",
        "account__InternationalReturnOverrideType",
        "account__TimeDuration"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v1/bulk_create_or_replace_sales_tax": {
      "operation": "bulkCreateOrReplaceSalesTax",
      "family": "account",
      "method": "POST",
      "path": "/sell/account/v1/bulk_create_or_replace_sales_tax",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method creates or updates multiple sales-tax table entries. Sales-tax tables can be set up for countries that support different tax jurisdictions . Note: Sales-tax tables are only avail Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account__BulkSalesTaxInput"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "account__BulkSalesTaxInput",
        "account__SalesTaxInput"
      ],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__UpdatedSalesTaxResponse"
          },
          "location": false
        },
        "207": {
          "schema": {
            "$ref": "#/$defs/account__UpdatedSalesTaxResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__UpdatedSalesTaxResponse",
        "account__UpdatedSalesTaxEntry"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": [
        [
          "updatedSalesTaxEntries",
          "*",
          "statusCode"
        ],
        [
          "updatedSalesTaxEntries",
          "*",
          "statusCode"
        ]
      ],
      "bulk": {
        "request": "salesTaxInputList",
        "response": "updatedSalesTaxEntries",
        "keys": [
          "countryCode",
          "jurisdictionId"
        ],
        "request_aliases": {
          "jurisdictionId": "salesTaxJurisdictionId"
        },
        "limit": 10
      }
    },
    "GET /sell/account/v1/sales_tax/{countryCode}/{jurisdictionId}": {
      "operation": "getSalesTax",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/sales_tax/{countryCode}/{jurisdictionId}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This call retrieves the current sales-tax table entry for a specific tax jurisdiction. Specify the jurisdiction to retrieve using the countryCode and jurisdictionId path parameters. All four One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "countryCode": {
                "type": "string",
                "description": "This path parameter specifies the two-letter ISO 3166 code for the country whose sales tax table you want to retrieve. Note: Sales-tax tables are available only for the US and Canada marketplaces. Therefore, the only supported values are: US CA",
                "maxLength": 262144,
                "minLength": 1
              },
              "jurisdictionId": {
                "type": "string",
                "description": "This path parameter specifies the ID of the sales tax jurisdiction for the tax table entry to be retrieved. Valid jurisdiction IDs can be retrieved using the getSalesTaxJurisdiction method of the Metadata API. Note: When countryCode is set to US , the only supported values for jurisdictionId are: AS (American Samoa) GU (Guam MP Northern Mariana Islands PW (Palau) VI (US Virgin Islands)",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "countryCode",
              "jurisdictionId"
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
          "name": "countryCode",
          "explode": true
        },
        {
          "location": "path",
          "name": "jurisdictionId",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__SalesTax"
          },
          "location": false
        },
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [
        "account__SalesTax"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "PUT /sell/account/v1/sales_tax/{countryCode}/{jurisdictionId}": {
      "operation": "createOrReplaceSalesTax",
      "family": "account",
      "method": "PUT",
      "path": "/sell/account/v1/sales_tax/{countryCode}/{jurisdictionId}",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method creates or updates a sales-tax table entry for a jurisdiction. Specify the tax table entry you want to configure using the two path parameters: countryCode and jurisdictionId . A Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "countryCode": {
                "type": "string",
                "description": "This path parameter specifies the two-letter ISO 3166 code for the country for which you want to create a sales tax table entry. Note: Sales-tax tables are available only for the US and Canada marketplaces. Therefore, the only supported values are: US CA",
                "maxLength": 262144,
                "minLength": 1
              },
              "jurisdictionId": {
                "type": "string",
                "description": "This path parameter specifies the ID of the tax jurisdiction for the table entry to be created. Valid jurisdiction IDs can be retrieved using the getSalesTaxJurisdiction method of the Metadata API. Note: When countryCode is set to US , the only supported values for jurisdictionId are: AS (American Samoa) GU (Guam) MP (Northern Mariana Islands) PW (Palau) VI (US Virgin Islands)",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "countryCode",
              "jurisdictionId"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/account__SalesTaxBase"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "account__SalesTaxBase"
      ],
      "wire": [
        {
          "location": "path",
          "name": "countryCode",
          "explode": true
        },
        {
          "location": "path",
          "name": "jurisdictionId",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "DELETE /sell/account/v1/sales_tax/{countryCode}/{jurisdictionId}": {
      "operation": "deleteSalesTax",
      "family": "account",
      "method": "DELETE",
      "path": "/sell/account/v1/sales_tax/{countryCode}/{jurisdictionId}",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This call deletes a sales-tax table entry for a jurisdiction. Specify the jurisdiction to delete using the countryCode and jurisdictionId path parameters. Note: Sales-tax tables are only ava Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "countryCode": {
                "type": "string",
                "description": "This path parameter specifies the two-letter ISO 3166 code for the country whose sales tax table entry you want to delete. Note: Sales-tax tables are available only for the US and Canada marketplaces. Therefore, the only supported values are: US CA",
                "maxLength": 262144,
                "minLength": 1
              },
              "jurisdictionId": {
                "type": "string",
                "description": "This path parameter specifies the ID of the sales tax jurisdiction whose table entry you want to delete. Valid jurisdiction IDs can be retrieved using the getSalesTaxJurisdiction method of the Metadata API. Note: When countryCode is set to US , the only supported values for jurisdictionId are: AS (American Samoa) GU (Guam) MP (Northern Mariana Islands) PW (Palau) VI (US Virgin Islands)",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "countryCode",
              "jurisdictionId"
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
          "name": "countryCode",
          "explode": true
        },
        {
          "location": "path",
          "name": "jurisdictionId",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/sales_tax": {
      "operation": "getSalesTaxes",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/sales_tax",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "Use this call to retrieve all sales tax table entries that the seller has defined for a specific country. All four response fields will be returned for each tax jurisdiction that matches the One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "country_code": {
                "type": "string",
                "description": "This path parameter specifies the two-letter ISO 3166 code for the country whose tax table you want to retrieve. Note: Sales-tax tables are available only for the US and Canada marketplaces. Therefore, the only supported values are: US CA For implementation help, refer to eBay API documentation at https://developer.ebay.com/api-docs/sell/account/types/ba:CountryCodeEnum",
                "maxLength": 262144
              }
            },
            "required": [
              "country_code"
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
          "name": "country_code",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__SalesTaxes"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__SalesTaxes",
        "account__SalesTax"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/subscription": {
      "operation": "getSubscription",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/subscription",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves a list of subscriptions associated with the seller account. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "This field is for future use.",
                "maxLength": 262144
              },
              "continuation_token": {
                "type": "string",
                "description": "This field is for future use.",
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
          "name": "limit",
          "explode": true
        },
        {
          "location": "query",
          "name": "continuation_token",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__SubscriptionResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__SubscriptionResponse",
        "account__Subscription",
        "account__TimeDuration"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v1/advertising_eligibility": {
      "operation": "getAdvertisingEligibility",
      "family": "account",
      "method": "GET",
      "path": "/sell/account/v1/advertising_eligibility",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method allows developers to check the seller eligibility status for eBay advertising programs. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "program_types": {
                "type": "string",
                "description": "A comma-separated list of eBay advertising programs for which eligibility status will be returned. See the AdvertisingProgramEnum type for a list of supported values. If no programs are specified, the results will be returned for all programs.",
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
          "name": "program_types",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account__SellerEligibilityMultiProgramResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account__SellerEligibilityMultiProgramResponse",
        "account__SellerEligibilityResponse"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/account/v2/rate_table/{rate_table_id}": {
      "operation": "getRateTable",
      "family": "account_v2",
      "method": "GET",
      "path": "/sell/account/v2/rate_table/{rate_table_id}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method retrieves an existing rate table identified by the rate_table_id path parameter. Shipping rate tables are currently supported by the following marketplaces: United States, Canada One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "rate_table_id": {
                "type": "string",
                "description": "This path parameter is the unique identifier for the shipping rate table to retrieve. Use the getRateTables method of the Account API v1 to retrieve rate table IDs.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "rate_table_id"
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
          "name": "rate_table_id",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/account_v2__RateTableDetails"
          },
          "location": false
        }
      },
      "response_definitions": [
        "account_v2__RateTableDetails",
        "account_v2__Rate",
        "account_v2__Amount"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v2/rate_table/{rate_table_id}/update_shipping_cost": {
      "operation": "updateShippingCost",
      "family": "account_v2",
      "method": "POST",
      "path": "/sell/account/v2/rate_table/{rate_table_id}/update_shipping_cost",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method allows sellers to update shippingCost and/or additionalCost information for an existing shipping rate table identified by the rate_table_id path parameter. A successful call retu Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "rate_table_id": {
                "type": "string",
                "description": "This path parameter is the unique identifier for the shipping rate table for which shipping costs will be updated. Use the getRateTables method of the Account API v1 to retrieve rate table IDs.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "rate_table_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/account_v2__RateTableUpdate"
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "account_v2__RateTableUpdate",
        "account_v2__RateUpdate",
        "account_v2__Amount"
      ],
      "wire": [
        {
          "location": "path",
          "name": "rate_table_id",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v2/combined_shipping_rules/create_calculated_shipping_rules": {
      "operation": "createCalculatedShippingRules",
      "family": "account_v2",
      "method": "POST",
      "path": "/sell/account/v2/combined_shipping_rules/create_calculated_shipping_rules",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method creates or registers calculated shipping rules that determine combined shipping costs based on weight, item count, or cost parameters for an authenticated seller. This shipping r Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account_v2__CreateCalculatedShippingRulesRequest"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [
        "account_v2__CreateCalculatedShippingRulesRequest",
        "account_v2__CalculatedHandlingRuleType",
        "account_v2__Amount",
        "account_v2__CalculatedShippingRuleType",
        "account_v2__CombinedShippingRule",
        "account_v2__MeasureType"
      ],
      "wire": [],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v2/combined_shipping_rules/create_flat_shipping_rules": {
      "operation": "createFlatShippingRules",
      "family": "account_v2",
      "method": "POST",
      "path": "/sell/account/v2/combined_shipping_rules/create_flat_shipping_rules",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method is used to create fixed-rate (flat) shipping rules that apply standard combined shipping costs for a seller’s listings. Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account_v2__CreateFlatShippingRulesRequest"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [
        "account_v2__CreateFlatShippingRulesRequest",
        "account_v2__FlatShippingRuleType",
        "account_v2__CombinedShippingRule",
        "account_v2__Amount",
        "account_v2__MeasureType"
      ],
      "wire": [],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v2/combined_shipping_rules/create_promotional_shipping_rule": {
      "operation": "createPromotionalShippingRule",
      "family": "account_v2",
      "method": "POST",
      "path": "/sell/account/v2/combined_shipping_rules/create_promotional_shipping_rule",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method defines promotional shipping rules such as discounts or free-shipping thresholds, configurable by marketplace for the seller. Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account_v2__CreatePromotionalShippingRuleRequest"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [
        "account_v2__CreatePromotionalShippingRuleRequest",
        "account_v2__PromotionalShippingRuleType",
        "account_v2__Amount"
      ],
      "wire": [],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v2/combined_shipping_rules/update_calculated_shipping_rules": {
      "operation": "updateCalculatedShippingRules",
      "family": "account_v2",
      "method": "POST",
      "path": "/sell/account/v2/combined_shipping_rules/update_calculated_shipping_rules",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method updates previously defined calculated shipping rules to modify discount percentages, weight offsets, or amount parameters for the seller. Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account_v2__UpdateCalculatedShippingRulesRequest"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [
        "account_v2__UpdateCalculatedShippingRulesRequest",
        "account_v2__CalculatedHandlingRuleType",
        "account_v2__Amount",
        "account_v2__CalculatedShippingRuleType",
        "account_v2__CombinedShippingRule",
        "account_v2__MeasureType"
      ],
      "wire": [],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v2/combined_shipping_rules/update_combined_payments": {
      "operation": "updateCombinedPayments",
      "family": "account_v2",
      "method": "POST",
      "path": "/sell/account/v2/combined_shipping_rules/update_combined_payments",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method configures or modifies combined payment settings that determine how unpaid orders can be merged for a single invoice within a defined duration for the seller. Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account_v2__UpdateCombinedPaymentsRequest"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [
        "account_v2__UpdateCombinedPaymentsRequest"
      ],
      "wire": [],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v2/combined_shipping_rules/update_flat_shipping_rules": {
      "operation": "updateFlatShippingRules",
      "family": "account_v2",
      "method": "POST",
      "path": "/sell/account/v2/combined_shipping_rules/update_flat_shipping_rules",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method updates existing shipping rules. Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account_v2__UpdateFlatShippingRulesRequest"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [
        "account_v2__UpdateFlatShippingRulesRequest",
        "account_v2__FlatShippingRuleType",
        "account_v2__CombinedShippingRule",
        "account_v2__Amount",
        "account_v2__MeasureType"
      ],
      "wire": [],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/account/v2/combined_shipping_rules/update_promotional_shipping_rule": {
      "operation": "updatePromotionalShippingRule",
      "family": "account_v2",
      "method": "POST",
      "path": "/sell/account/v2/combined_shipping_rules/update_promotional_shipping_rule",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.account"
      ],
      "description": "This method updates an existing promotional shipping rule to adjust discount thresholds, eligibility criteria, or duration for the seller. Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/account_v2__UpdatePromotionalShippingRuleRequest"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [
        "account_v2__UpdatePromotionalShippingRuleRequest",
        "account_v2__PromotionalShippingRuleType",
        "account_v2__Amount"
      ],
      "wire": [],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/inventory/v1/bulk_create_or_replace_inventory_item": {
      "operation": "bulkCreateOrReplaceInventoryItem",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/bulk_create_or_replace_inventory_item",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "Note: Please note that any eBay listing created using the Inventory API cannot be revised or relisted using the Trading API calls. Note: Each listing can be revised up to 250 times in one ca Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/inventory__BulkInventoryItem"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__BulkInventoryItem",
        "inventory__InventoryItemWithSkuLocale",
        "inventory__Availability",
        "inventory__PickupAtLocationAvailability",
        "inventory__TimeDuration",
        "inventory__ShipToLocationAvailability",
        "inventory__AvailabilityDistribution",
        "inventory__ConditionDescriptor",
        "inventory__PackageWeightAndSize",
        "inventory__Dimension",
        "inventory__Weight",
        "inventory__Product"
      ],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkInventoryItemResponse"
          },
          "location": false
        },
        "207": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkInventoryItemResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__BulkInventoryItemResponse",
        "inventory__InventoryItemResponse",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [
        [
          "responses",
          "*",
          "errors",
          "*"
        ],
        [
          "responses",
          "*",
          "errors",
          "*"
        ]
      ],
      "error_prose_paths": [
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": [
        [
          "responses",
          "*",
          "statusCode"
        ],
        [
          "responses",
          "*",
          "statusCode"
        ]
      ],
      "bulk": {
        "request": "requests",
        "response": "responses",
        "keys": [
          "sku"
        ],
        "limit": 25
      }
    },
    "POST /sell/inventory/v1/bulk_get_inventory_item": {
      "operation": "bulkGetInventoryItem",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/bulk_get_inventory_item",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call retrieves up to 25 inventory item records. The SKU value of each inventory item record to retrieve is specified in the request payload. Note: In addition to the authorization heade One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/inventory__BulkGetInventoryItem"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__BulkGetInventoryItem",
        "inventory__GetInventoryItem"
      ],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkGetInventoryItemResponse"
          },
          "location": false
        },
        "207": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkGetInventoryItemResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__BulkGetInventoryItemResponse",
        "inventory__GetInventoryItemResponse",
        "inventory__Error",
        "inventory__ErrorParameter",
        "inventory__InventoryItemWithSkuLocaleGroupKeys",
        "inventory__AvailabilityWithAll",
        "inventory__PickupAtLocationAvailability",
        "inventory__TimeDuration",
        "inventory__ShipToLocationAvailabilityWithAll",
        "inventory__FormatAllocation",
        "inventory__AvailabilityDistribution",
        "inventory__ConditionDescriptor",
        "inventory__PackageWeightAndSize",
        "inventory__Dimension",
        "inventory__Weight",
        "inventory__Product"
      ],
      "error_paths": [
        [
          "responses",
          "*",
          "errors",
          "*"
        ],
        [
          "responses",
          "*",
          "errors",
          "*"
        ]
      ],
      "error_prose_paths": [
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": [
        [
          "responses",
          "*",
          "statusCode"
        ],
        [
          "responses",
          "*",
          "statusCode"
        ]
      ],
      "bulk": {
        "request": "requests",
        "response": "responses",
        "keys": [
          "sku"
        ],
        "limit": 25,
        "success_field": "inventoryItem"
      }
    },
    "POST /sell/inventory/v1/bulk_update_price_quantity": {
      "operation": "bulkUpdatePriceQuantity",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/bulk_update_price_quantity",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call is used by the seller to update the total ship-to-home quantity of one inventory item, and/or to update the price and/or quantity of one or more offers associated with one inventor Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/inventory__BulkPriceQuantity"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__BulkPriceQuantity",
        "inventory__PriceQuantity",
        "inventory__OfferPriceQuantity",
        "inventory__Amount",
        "inventory__ShipToLocationAvailability",
        "inventory__AvailabilityDistribution",
        "inventory__TimeDuration"
      ],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkPriceQuantityResponse"
          },
          "location": false
        },
        "207": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkPriceQuantityResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__BulkPriceQuantityResponse",
        "inventory__PriceQuantityResponse",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [
        [
          "responses",
          "*",
          "errors",
          "*"
        ],
        [
          "responses",
          "*",
          "errors",
          "*"
        ]
      ],
      "error_prose_paths": [
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": [
        [
          "responses",
          "*",
          "statusCode"
        ],
        [
          "responses",
          "*",
          "statusCode"
        ]
      ],
      "bulk": {
        "request": "requests",
        "response": "responses",
        "keys": [
          "sku",
          "offerId"
        ],
        "limit": 25,
        "expand_offers": true
      }
    },
    "GET /sell/inventory/v1/inventory_item/{sku}": {
      "operation": "getInventoryItem",
      "family": "inventory",
      "method": "GET",
      "path": "/sell/inventory/v1/inventory_item/{sku}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call retrieves the inventory item record for a given SKU. The SKU value is passed in at the end of the call URI. There is no request payload for this call. The authorization header is t One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "sku": {
                "type": "string",
                "description": "This path parameter specifies the seller-defined SKU value of the product whose inventory item record you wish to retrieve. Use the getInventoryItems method to retrieve SKU values. Max length : 50",
                "maxLength": 50,
                "minLength": 1
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
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "sku",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__InventoryItemWithSkuLocaleGroupid"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__InventoryItemWithSkuLocaleGroupid",
        "inventory__AvailabilityWithAll",
        "inventory__PickupAtLocationAvailability",
        "inventory__TimeDuration",
        "inventory__ShipToLocationAvailabilityWithAll",
        "inventory__FormatAllocation",
        "inventory__AvailabilityDistribution",
        "inventory__ConditionDescriptor",
        "inventory__PackageWeightAndSize",
        "inventory__Dimension",
        "inventory__Weight",
        "inventory__Product"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "PUT /sell/inventory/v1/inventory_item/{sku}": {
      "operation": "createOrReplaceInventoryItem",
      "family": "inventory",
      "method": "PUT",
      "path": "/sell/inventory/v1/inventory_item/{sku}",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "Note: Please note that any eBay listing created using the Inventory API cannot be revised or relisted using the Trading API calls. Note: Each listing can be revised up to 250 times in one ca Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "sku": {
                "type": "string",
                "description": "This path parameter specifies the seller-defined SKU value for the inventory item being created or updated. SKU values must be unique across the seller's inventory. Max length : 50",
                "maxLength": 50,
                "minLength": 1
              }
            },
            "required": [
              "sku"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/inventory__InventoryItem"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__InventoryItem",
        "inventory__Availability",
        "inventory__PickupAtLocationAvailability",
        "inventory__TimeDuration",
        "inventory__ShipToLocationAvailability",
        "inventory__AvailabilityDistribution",
        "inventory__ConditionDescriptor",
        "inventory__PackageWeightAndSize",
        "inventory__Dimension",
        "inventory__Weight",
        "inventory__Product"
      ],
      "wire": [
        {
          "location": "path",
          "name": "sku",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__BaseResponse"
          },
          "location": false
        },
        "201": {
          "schema": {
            "$ref": "#/$defs/inventory__BaseResponse"
          },
          "location": false
        },
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [
        "inventory__BaseResponse",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ],
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "DELETE /sell/inventory/v1/inventory_item/{sku}": {
      "operation": "deleteInventoryItem",
      "family": "inventory",
      "method": "DELETE",
      "path": "/sell/inventory/v1/inventory_item/{sku}",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call is used to delete an inventory item record associated with a specified SKU. A successful call will not only delete that inventory item record, but will also have the following effe Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "sku": {
                "type": "string",
                "description": "This path parameter specifies the seller-defined SKU value of the product whose inventory item record you wish to delete. Use the getInventoryItems method to retrieve SKU values. Max length : 50",
                "maxLength": 50,
                "minLength": 1
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
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "sku",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/inventory/v1/inventory_item": {
      "operation": "getInventoryItems",
      "family": "inventory",
      "method": "GET",
      "path": "/sell/inventory/v1/inventory_item",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call retrieves all inventory item records defined for the seller's account. The limit query parameter allows the seller to control how many records are returned per page, and the offset One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "The value passed in this query parameter sets the maximum number of records to return per page of data. Although this field is a string, the value passed in this field should be an integer from 1 to 200 . Min: 1 Max: 200 Default: 25",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$"
              },
              "offset": {
                "type": "string",
                "description": "The value passed in this query parameter sets the page number to retrieve. The first page of records has a value of 0 , the second page of records has a value of 1 , and so on. If this query parameter is not set, its value defaults to 0 , and the first page of records is returned.",
                "maxLength": 262144,
                "pattern": "^(?:0|[1-9][0-9]{0,8})$"
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
          "name": "limit",
          "explode": true
        },
        {
          "location": "query",
          "name": "offset",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__InventoryItems"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__InventoryItems",
        "inventory__InventoryItemWithSkuLocaleGroupid",
        "inventory__AvailabilityWithAll",
        "inventory__PickupAtLocationAvailability",
        "inventory__TimeDuration",
        "inventory__ShipToLocationAvailabilityWithAll",
        "inventory__FormatAllocation",
        "inventory__AvailabilityDistribution",
        "inventory__ConditionDescriptor",
        "inventory__PackageWeightAndSize",
        "inventory__Dimension",
        "inventory__Weight",
        "inventory__Product"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/inventory/v1/inventory_item/{sku}/product_compatibility": {
      "operation": "getProductCompatibility",
      "family": "inventory",
      "method": "GET",
      "path": "/sell/inventory/v1/inventory_item/{sku}/product_compatibility",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call is used by the seller to retrieve the list of products that are compatible with the inventory item. The SKU value for the inventory item is passed into the call URI, and a successf One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "sku": {
                "type": "string",
                "description": "This path parameter specifies the SKU (stock keeping unit) of the inventory item associated with the product compatibility list being retrieved. Use the getInventoryItems method to retrieve SKU values.",
                "maxLength": 50,
                "minLength": 1
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
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "sku",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__Compatibility"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__Compatibility",
        "inventory__CompatibleProduct",
        "inventory__NameValueList",
        "inventory__ProductFamilyProperties",
        "inventory__ProductIdentifier"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "PUT /sell/inventory/v1/inventory_item/{sku}/product_compatibility": {
      "operation": "createOrReplaceProductCompatibility",
      "family": "inventory",
      "method": "PUT",
      "path": "/sell/inventory/v1/inventory_item/{sku}/product_compatibility",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call is used by the seller to create or replace a list of products that are compatible with the inventory item. The inventory item is identified with a SKU value in the URI. Product com Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "sku": {
                "type": "string",
                "description": "This path parameter specifies the SKU (stock keeping unit) of the inventory item associated with the compatibility list being created. Use the getInventoryItems method to retrieve SKU values.",
                "maxLength": 50,
                "minLength": 1
              }
            },
            "required": [
              "sku"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/inventory__Compatibility"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__Compatibility",
        "inventory__CompatibleProduct",
        "inventory__NameValueList",
        "inventory__ProductFamilyProperties",
        "inventory__ProductIdentifier"
      ],
      "wire": [
        {
          "location": "path",
          "name": "sku",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__BaseResponse"
          },
          "location": false
        },
        "201": {
          "schema": {
            "$ref": "#/$defs/inventory__BaseResponse"
          },
          "location": false
        },
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [
        "inventory__BaseResponse",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ],
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "DELETE /sell/inventory/v1/inventory_item/{sku}/product_compatibility": {
      "operation": "deleteProductCompatibility",
      "family": "inventory",
      "method": "DELETE",
      "path": "/sell/inventory/v1/inventory_item/{sku}/product_compatibility",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call is used by the seller to delete the list of products that are compatible with the inventory item that is associated with the compatible product list. The inventory item is identifi Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "sku": {
                "type": "string",
                "description": "This path parameter specifies the SKU (stock keeping unit) of the inventory item that is associated with the product compatibility list that is being deleted. Use the getInventoryItems method to retrieve SKU values.",
                "maxLength": 50,
                "minLength": 1
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
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "location": "path",
          "name": "sku",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/inventory/v1/inventory_item_group/{inventoryItemGroupKey}": {
      "operation": "getInventoryItemGroup",
      "family": "inventory",
      "method": "GET",
      "path": "/sell/inventory/v1/inventory_item_group/{inventoryItemGroupKey}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call retrieves the inventory item group for a given inventoryItemGroupKey value. The inventoryItemGroupKey value is passed in at the end of the call URI. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "inventoryItemGroupKey": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the inventory item group being retrieved. This value is assigned by the seller when an inventory item group is created.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "inventoryItemGroupKey"
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
          "name": "inventoryItemGroupKey",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__InventoryItemGroup"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__InventoryItemGroup",
        "inventory__VariesBy",
        "inventory__Specification"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "PUT /sell/inventory/v1/inventory_item_group/{inventoryItemGroupKey}": {
      "operation": "createOrReplaceInventoryItemGroup",
      "family": "inventory",
      "method": "PUT",
      "path": "/sell/inventory/v1/inventory_item_group/{inventoryItemGroupKey}",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "Note: Each listing can be revised up to 250 times in one calendar day. If this revision threshold is reached, the seller will be blocked from revising the item until the next calendar day. T Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "inventoryItemGroupKey": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the inventory item group being created or updated. This identifier is defined by the seller. This value cannot be changed once it is set. Max Length: 50",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "inventoryItemGroupKey"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/inventory__InventoryItemGroup"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__InventoryItemGroup",
        "inventory__VariesBy",
        "inventory__Specification"
      ],
      "wire": [
        {
          "location": "path",
          "name": "inventoryItemGroupKey",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__BaseResponse"
          },
          "location": false
        },
        "201": {
          "schema": {
            "$ref": "#/$defs/inventory__BaseResponse"
          },
          "location": false
        },
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [
        "inventory__BaseResponse",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ],
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "DELETE /sell/inventory/v1/inventory_item_group/{inventoryItemGroupKey}": {
      "operation": "deleteInventoryItemGroup",
      "family": "inventory",
      "method": "DELETE",
      "path": "/sell/inventory/v1/inventory_item_group/{inventoryItemGroupKey}",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call deletes the inventory item group for a given inventoryItemGroupKey value. Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "inventoryItemGroupKey": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the inventory item group being deleted. This value is assigned by the seller when an inventory item group is created.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "inventoryItemGroupKey"
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
          "name": "inventoryItemGroupKey",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/inventory/v1/bulk_migrate_listing": {
      "operation": "bulkMigrateListing",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/bulk_migrate_listing",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call is used to convert existing eBay Listings to the corresponding Inventory API objects. If an eBay listing is successfully migrated to the Inventory API model, new Inventory Location Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/inventory__BulkMigrateListing"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__BulkMigrateListing",
        "inventory__MigrateListing"
      ],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkMigrateListingResponse"
          },
          "location": false
        },
        "207": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkMigrateListingResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__BulkMigrateListingResponse",
        "inventory__MigrateListingResponse",
        "inventory__Error",
        "inventory__ErrorParameter",
        "inventory__InventoryItemListing"
      ],
      "error_paths": [
        [
          "responses",
          "*",
          "errors",
          "*"
        ],
        [
          "responses",
          "*",
          "errors",
          "*"
        ]
      ],
      "error_prose_paths": [
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": [
        [
          "responses",
          "*",
          "statusCode"
        ],
        [
          "responses",
          "*",
          "statusCode"
        ]
      ],
      "bulk": {
        "request": "requests",
        "response": "responses",
        "keys": [
          "listingId"
        ],
        "limit": 5,
        "success_field": "inventoryItems"
      }
    },
    "GET /sell/inventory/v1/listing/{listingId}/sku/{sku}/locations": {
      "operation": "getSkuLocationMapping",
      "family": "inventory",
      "method": "GET",
      "path": "/sell/inventory/v1/listing/{listingId}/sku/{sku}/locations",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This method allows sellers to retrieve the locations mapped to a specific SKU within a listing. The listingId and sku of the listing are passed in as path parameters. This method only retrie One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listingId": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the listing that the SKU belongs to for which all mapped locations will be retrieved. Use the getOffers method of the Inventory API or the GetMyEbaySelling method of the Trading API to retrieve all listing IDs for all active listings.",
                "maxLength": 262144,
                "minLength": 1
              },
              "sku": {
                "type": "string",
                "description": "This path parameter specifies the seller-defined SKU value of the item/variation for which location mappings will be retrieved. This SKU value must be defined in the listing specified in listingId parameter Use the getOffers method of the Inventory API or the GetMyEbaySelling method of the Trading API to retrieve all SKUs for all active listings.",
                "maxLength": 50,
                "minLength": 1
              }
            },
            "required": [
              "listingId",
              "sku"
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
          "name": "listingId",
          "explode": true
        },
        {
          "location": "path",
          "name": "sku",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__LocationMapping"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__LocationMapping",
        "inventory__LocationAvailabilityDetails"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "PUT /sell/inventory/v1/listing/{listingId}/sku/{sku}/locations": {
      "operation": "createOrReplaceSkuLocationMapping",
      "family": "inventory",
      "method": "PUT",
      "path": "/sell/inventory/v1/listing/{listingId}/sku/{sku}/locations",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This method allows sellers to map multiple fulfillment center locations to single-SKU listing, or to a single SKU within a multiple-variation listing. This allows eBay to leverage the locati Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listingId": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the listing for which multiple fulfillment center locations will be mapped to a SKU within that listing. Use the getOffers method of the Inventory API or the GetMyEbaySelling method of the Trading API to retrieve all listing IDs for all active listings.",
                "maxLength": 262144,
                "minLength": 1
              },
              "sku": {
                "type": "string",
                "description": "This path parameter specifies the seller-defined SKU value of the item/variation for which multiple fulfillment center locations will be mapped. This SKU value must be defined in the listing specified in listingId parameter. Use the getOffers method of the Inventory API or the GetMyEbaySelling method of the Trading API to retrieve all listing IDs for all active listings. Note: SKU values can be updated by a seller at any time. If a seller updates a SKU value that is being used for location mapping, this change will not be reflected until the mapping is updated through the createOrReplaceSkuLocationMapping method.",
                "maxLength": 50,
                "minLength": 1
              }
            },
            "required": [
              "listingId",
              "sku"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/inventory__LocationMapping"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__LocationMapping",
        "inventory__LocationAvailabilityDetails"
      ],
      "wire": [
        {
          "location": "path",
          "name": "listingId",
          "explode": true
        },
        {
          "location": "path",
          "name": "sku",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "DELETE /sell/inventory/v1/listing/{listingId}/sku/{sku}/locations": {
      "operation": "deleteSkuLocationMapping",
      "family": "inventory",
      "method": "DELETE",
      "path": "/sell/inventory/v1/listing/{listingId}/sku/{sku}/locations",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This method allows sellers to remove all location mappings associated with a specific SKU within a listing. The listingId and sku of the listing are passed in as path parameters. Important!  Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "listingId": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the listing that the SKU belongs to for which all mapped locations will be removed. Use the getOffers method of the Inventory API or the GetMyEbaySelling method of the Trading API to retrieve all listing IDs for all active listings.",
                "maxLength": 262144,
                "minLength": 1
              },
              "sku": {
                "type": "string",
                "description": "This path parameter specifies the seller-defined SKU value of the item/variation for which location mappings will be removed. This SKU value must be defined in the listing specified in listingId parameter Use the getOffers method of the Inventory API or the GetMyEbaySelling method of the Trading API to retrieve all SKUs for all active listings.",
                "maxLength": 50,
                "minLength": 1
              }
            },
            "required": [
              "listingId",
              "sku"
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
          "name": "listingId",
          "explode": true
        },
        {
          "location": "path",
          "name": "sku",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/inventory/v1/bulk_create_offer": {
      "operation": "bulkCreateOffer",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/bulk_create_offer",
      "risk": "W",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call creates multiple offers (up to 25) for specific inventory items on a specific eBay marketplace. Although it is not a requirement for the seller to create complete offers (with all  Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/inventory__BulkEbayOfferDetailsWithKeys"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__BulkEbayOfferDetailsWithKeys",
        "inventory__EbayOfferDetailsWithKeys",
        "inventory__Charity",
        "inventory__ExtendedProducerResponsibility",
        "inventory__Amount",
        "inventory__ListingPolicies",
        "inventory__BestOffer",
        "inventory__RegionalProductCompliancePolicies",
        "inventory__CountryPolicy",
        "inventory__RegionalTakeBackPolicies",
        "inventory__ShippingCostOverride",
        "inventory__PricingSummary",
        "inventory__Regulatory",
        "inventory__Document",
        "inventory__EnergyEfficiencyLabel",
        "inventory__Hazmat",
        "inventory__Manufacturer",
        "inventory__ProductSafety",
        "inventory__ResponsiblePerson",
        "inventory__Tax"
      ],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkOfferResponse"
          },
          "location": false
        },
        "207": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkOfferResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__BulkOfferResponse",
        "inventory__OfferSkuResponse",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [
        [
          "responses",
          "*",
          "errors",
          "*"
        ],
        [
          "responses",
          "*",
          "errors",
          "*"
        ]
      ],
      "error_prose_paths": [
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": [
        [
          "responses",
          "*",
          "statusCode"
        ],
        [
          "responses",
          "*",
          "statusCode"
        ]
      ],
      "bulk": {
        "request": "requests",
        "response": "responses",
        "keys": [
          "sku",
          "marketplaceId",
          "format"
        ],
        "optional_keys": [
          "format"
        ],
        "limit": 25,
        "success_field": "offerId"
      }
    },
    "POST /sell/inventory/v1/bulk_publish_offer": {
      "operation": "bulkPublishOffer",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/bulk_publish_offer",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "Note: Each listing can be revised up to 250 times in one calendar day. If this revision threshold is reached, the seller will be blocked from revising the item until the next calendar day. T Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/inventory__BulkOffer"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__BulkOffer",
        "inventory__OfferKeyWithId"
      ],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkPublishResponse"
          },
          "location": false
        },
        "207": {
          "schema": {
            "$ref": "#/$defs/inventory__BulkPublishResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__BulkPublishResponse",
        "inventory__OfferResponseWithListingId",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [
        [
          "responses",
          "*",
          "errors",
          "*"
        ],
        [
          "responses",
          "*",
          "errors",
          "*"
        ]
      ],
      "error_prose_paths": [
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "errors",
          "*",
          "parameters"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "responses",
          "*",
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": [
        [
          "responses",
          "*",
          "statusCode"
        ],
        [
          "responses",
          "*",
          "statusCode"
        ]
      ],
      "bulk": {
        "request": "requests",
        "response": "responses",
        "keys": [
          "offerId"
        ],
        "limit": 25,
        "success_field": "listingId"
      }
    },
    "GET /sell/inventory/v1/offer": {
      "operation": "getOffers",
      "family": "inventory",
      "method": "GET",
      "path": "/sell/inventory/v1/offer",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call retrieves all existing offers for the specified SKU value. The seller has the option of limiting the offers that are retrieved to a specific eBay marketplace, or to a listing forma One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "format": {
                "type": "string",
                "description": "This enumeration value sets the listing format for the offers being retrieved. This query parameter will be passed in if the seller only wants to see offers in a specified listing format, such as FIXED_PRICE .",
                "maxLength": 262144
              },
              "limit": {
                "type": "string",
                "description": "The value passed in this query parameter sets the maximum number of records to return per page of data. Although this field is a string, the value passed in this field should be a positive integer value. If this query parameter is not set, up to 100 records will be returned on each page of results.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$"
              },
              "marketplace_id": {
                "type": "string",
                "description": "The unique identifier of the eBay marketplace. This query parameter will be passed in if the seller only wants to see the product's offers on a specific eBay marketplace. Note: At this time, the same SKU value can not be offered across multiple eBay marketplaces, so the marketplace_id query parameter currently does not have any practical use for this call.",
                "maxLength": 262144
              },
              "offset": {
                "type": "string",
                "description": "The value passed in this query parameter sets the page number to retrieve. Although this field is a string, the value passed in this field should be a integer value equal to or greater than 0 . The first page of records has a value of 0 , the second page of records has a value of 1 , and so on. If this query parameter is not set, its value defaults to 0 , and the first page of records is returned.",
                "maxLength": 262144,
                "pattern": "^(?:0|[1-9][0-9]{0,8})$"
              },
              "sku": {
                "type": "string",
                "description": "The seller-defined SKU value is passed in as a query parameter. All offers associated with this product are returned in the response. Note: The same SKU can be offered through an auction and a fixed-price listing concurrently. If this is the case, getOffers will return two offers. Otherwise, only one offer will be returned. Use the getInventoryItems method to retrieve SKU values. Max length : 50.",
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
          "name": "format",
          "explode": true
        },
        {
          "location": "query",
          "name": "limit",
          "explode": true
        },
        {
          "location": "query",
          "name": "marketplace_id",
          "explode": true
        },
        {
          "location": "query",
          "name": "offset",
          "explode": true
        },
        {
          "location": "query",
          "name": "sku",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__Offers"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__Offers",
        "inventory__EbayOfferDetailsWithAll",
        "inventory__Charity",
        "inventory__ExtendedProducerResponsibility",
        "inventory__Amount",
        "inventory__ListingDetails",
        "inventory__ListingPolicies",
        "inventory__BestOffer",
        "inventory__RegionalProductCompliancePolicies",
        "inventory__CountryPolicy",
        "inventory__RegionalTakeBackPolicies",
        "inventory__ShippingCostOverride",
        "inventory__PricingSummary",
        "inventory__Regulatory",
        "inventory__Document",
        "inventory__EnergyEfficiencyLabel",
        "inventory__Hazmat",
        "inventory__Manufacturer",
        "inventory__ProductSafety",
        "inventory__ResponsiblePerson",
        "inventory__Tax"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/inventory/v1/offer": {
      "operation": "createOffer",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/offer",
      "risk": "W",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call creates an offer for a specific inventory item on a specific eBay marketplace. It is up to the sellers whether they want to create a complete offer (with all necessary details) rig Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/inventory__EbayOfferDetailsWithKeys"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__EbayOfferDetailsWithKeys",
        "inventory__Charity",
        "inventory__ExtendedProducerResponsibility",
        "inventory__Amount",
        "inventory__ListingPolicies",
        "inventory__BestOffer",
        "inventory__RegionalProductCompliancePolicies",
        "inventory__CountryPolicy",
        "inventory__RegionalTakeBackPolicies",
        "inventory__ShippingCostOverride",
        "inventory__PricingSummary",
        "inventory__Regulatory",
        "inventory__Document",
        "inventory__EnergyEfficiencyLabel",
        "inventory__Hazmat",
        "inventory__Manufacturer",
        "inventory__ProductSafety",
        "inventory__ResponsiblePerson",
        "inventory__Tax"
      ],
      "wire": [],
      "responses": {
        "201": {
          "schema": {
            "$ref": "#/$defs/inventory__OfferResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__OfferResponse",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "GET /sell/inventory/v1/offer/{offerId}": {
      "operation": "getOffer",
      "family": "inventory",
      "method": "GET",
      "path": "/sell/inventory/v1/offer/{offerId}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call retrieves a specific published or unpublished offer. The unique identifier of the offer ( offerId ) is passed in at the end of the call URI. The authorization header is the only re One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "offerId": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the offer that is to be retrieved. Use the getOffers method to retrieve offer IDs.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "offerId"
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
          "name": "offerId",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__EbayOfferDetailsWithAll"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__EbayOfferDetailsWithAll",
        "inventory__Charity",
        "inventory__ExtendedProducerResponsibility",
        "inventory__Amount",
        "inventory__ListingDetails",
        "inventory__ListingPolicies",
        "inventory__BestOffer",
        "inventory__RegionalProductCompliancePolicies",
        "inventory__CountryPolicy",
        "inventory__RegionalTakeBackPolicies",
        "inventory__ShippingCostOverride",
        "inventory__PricingSummary",
        "inventory__Regulatory",
        "inventory__Document",
        "inventory__EnergyEfficiencyLabel",
        "inventory__Hazmat",
        "inventory__Manufacturer",
        "inventory__ProductSafety",
        "inventory__ResponsiblePerson",
        "inventory__Tax"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "PUT /sell/inventory/v1/offer/{offerId}": {
      "operation": "updateOffer",
      "family": "inventory",
      "method": "PUT",
      "path": "/sell/inventory/v1/offer/{offerId}",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call updates an existing offer. An existing offer may be in published state (active eBay listing), or in an unpublished state and yet to be published with the publishOffer call. The uni Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "offerId": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the offer being updated. Use the getOffers method to retrieve offer IDs.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "offerId"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/inventory__EbayOfferDetailsWithId"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__EbayOfferDetailsWithId",
        "inventory__Charity",
        "inventory__ExtendedProducerResponsibility",
        "inventory__Amount",
        "inventory__ListingPolicies",
        "inventory__BestOffer",
        "inventory__RegionalProductCompliancePolicies",
        "inventory__CountryPolicy",
        "inventory__RegionalTakeBackPolicies",
        "inventory__ShippingCostOverride",
        "inventory__PricingSummary",
        "inventory__Regulatory",
        "inventory__Document",
        "inventory__EnergyEfficiencyLabel",
        "inventory__Hazmat",
        "inventory__Manufacturer",
        "inventory__ProductSafety",
        "inventory__ResponsiblePerson",
        "inventory__Tax"
      ],
      "wire": [
        {
          "location": "path",
          "name": "offerId",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__OfferResponse"
          },
          "location": false
        },
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [
        "inventory__OfferResponse",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "DELETE /sell/inventory/v1/offer/{offerId}": {
      "operation": "deleteOffer",
      "family": "inventory",
      "method": "DELETE",
      "path": "/sell/inventory/v1/offer/{offerId}",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "If used against an unpublished offer, this call will permanently delete that offer. In the case of a published offer (or live eBay listing), a successful call will either end the single-vari Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "offerId": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the offer being deleted. Use the getOffers method to retrieve offer IDs.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "offerId"
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
          "name": "offerId",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/inventory/v1/offer/get_listing_fees": {
      "operation": "getListingFees",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/offer/get_listing_fees",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call is used to retrieve the expected listing fees for up to 250 unpublished offers. An array of one or more offerId values are passed in under the offers container. In the response pay One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/inventory__OfferKeysWithId"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__OfferKeysWithId",
        "inventory__OfferKeyWithId"
      ],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__FeesSummaryResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__FeesSummaryResponse",
        "inventory__FeeSummary",
        "inventory__Fee",
        "inventory__Amount",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "feeSummaries",
          "*",
          "warnings",
          "*",
          "message"
        ],
        [
          "feeSummaries",
          "*",
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "feeSummaries",
          "*",
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "POST /sell/inventory/v1/offer/{offerId}/publish": {
      "operation": "publishOffer",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/offer/{offerId}/publish",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "Note: Each listing can be revised up to 250 times in one calendar day. If this revision threshold is reached, the seller will be blocked from revising the item until the next calendar day. T Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "offerId": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the offer that is to be published. Use the getOffers method to retrieve offer IDs.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "offerId"
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
          "name": "offerId",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__PublishResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__PublishResponse",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "POST /sell/inventory/v1/offer/publish_by_inventory_item_group": {
      "operation": "publishOfferByInventoryItemGroup",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/offer/publish_by_inventory_item_group",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "Note: Please note that any eBay listing created using the Inventory API cannot be revised or relisted using the Trading API calls. Note: Each listing can be revised up to 250 times in one ca Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/inventory__PublishByInventoryItemGroupRequest"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__PublishByInventoryItemGroupRequest"
      ],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__PublishResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__PublishResponse",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "POST /sell/inventory/v1/offer/{offerId}/withdraw": {
      "operation": "withdrawOffer",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/offer/{offerId}/withdraw",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call is used to end a single-variation listing that is associated with the specified offer. This call is used in place of the deleteOffer call if the seller only wants to end the listin Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "offerId": {
                "type": "string",
                "description": "This path parameter specifies the unique identifier of the offer that is to be withdrawn. Use the getOffers method to retrieve offer IDs.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "offerId"
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
          "name": "offerId",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__WithdrawResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__WithdrawResponse",
        "inventory__Error",
        "inventory__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "POST /sell/inventory/v1/offer/withdraw_by_inventory_item_group": {
      "operation": "withdrawOfferByInventoryItemGroup",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call is used to end a multiple-variation eBay listing that is associated with the specified inventory item group. This call only ends multiple-variation eBay listing associated with the Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/inventory__WithdrawByInventoryItemGroupRequest"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__WithdrawByInventoryItemGroupRequest"
      ],
      "wire": [],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/inventory/v1/location/{merchantLocationKey}": {
      "operation": "getInventoryLocation",
      "family": "inventory",
      "method": "GET",
      "path": "/sell/inventory/v1/location/{merchantLocationKey}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call retrieves all defined details of the inventory location that is specified by the merchantLocationKey path parameter. A successful call will return an HTTP status value of 200 OK . One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "merchantLocationKey": {
                "type": "string",
                "description": "This path parameter specifies the unique merchant-defined key (ID) for an inventory location that is being retrieved. Use the getInventoryLocations method to retrieve merchant location keys. Max length : 36",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "merchantLocationKey"
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
          "name": "merchantLocationKey",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__InventoryLocationResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__InventoryLocationResponse",
        "inventory__Location",
        "inventory__Address",
        "inventory__GeoCoordinates",
        "inventory__OperatingHours",
        "inventory__Interval",
        "inventory__SpecialHours",
        "inventory__FulfillmentCenterSpecifications",
        "inventory__SameDayShippingCutOffTimes",
        "inventory__Overrides",
        "inventory__WeeklySchedule"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/inventory/v1/location/{merchantLocationKey}": {
      "operation": "createInventoryLocation",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/location/{merchantLocationKey}",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "Use this call to create a new inventory location. In order to create and publish an offer (and create an eBay listing), a seller must have at least one location, as every offer must be assoc Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "merchantLocationKey": {
                "type": "string",
                "description": "This path parameter specifies the unique, seller-defined key (ID) for an inventory location. Max length : 36",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "merchantLocationKey"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/inventory__InventoryLocationFull"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__InventoryLocationFull",
        "inventory__LocationDetails",
        "inventory__Address",
        "inventory__GeoCoordinates",
        "inventory__OperatingHours",
        "inventory__Interval",
        "inventory__SpecialHours",
        "inventory__FulfillmentCenterSpecifications",
        "inventory__SameDayShippingCutOffTimes",
        "inventory__Overrides",
        "inventory__WeeklySchedule"
      ],
      "wire": [
        {
          "location": "path",
          "name": "merchantLocationKey",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "DELETE /sell/inventory/v1/location/{merchantLocationKey}": {
      "operation": "deleteInventoryLocation",
      "family": "inventory",
      "method": "DELETE",
      "path": "/sell/inventory/v1/location/{merchantLocationKey}",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call deletes the inventory location that is specified in the merchantLocationKey path parameter. Note that deleting a location will not affect any active eBay listings associated with t Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "merchantLocationKey": {
                "type": "string",
                "description": "This path parameter specifies the unique merchant-defined key (ID) for the inventory location that is to be deleted. Use the getInventoryLocations method to retrieve merchant location keys. Max length : 36",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "merchantLocationKey"
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
          "name": "merchantLocationKey",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/inventory/v1/location/{merchantLocationKey}/disable": {
      "operation": "disableInventoryLocation",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/location/{merchantLocationKey}/disable",
      "risk": "D",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call disables the inventory location that is specified in the merchantLocationKey path parameter. Sellers can not load/modify inventory to disabled locations. Note that disabling a loca Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "merchantLocationKey": {
                "type": "string",
                "description": "This path parameter specifies the unique merchant-defined key (ID) for an inventory location that is to be disabled. Use the getInventoryLocations method to retrieve merchant location keys. Max length : 36",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "merchantLocationKey"
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
          "name": "merchantLocationKey",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "type": "object",
            "additionalProperties": true
          },
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/inventory/v1/location/{merchantLocationKey}/enable": {
      "operation": "enableInventoryLocation",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/location/{merchantLocationKey}/enable",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call enables a disabled inventory location that is specified in the merchantLocationKey path parameter. Once a disabled location is enabled, sellers can start loading/modifying inventor Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "merchantLocationKey": {
                "type": "string",
                "description": "This path parameter specifies unique merchant-defined key (ID) for a disabled inventory location that is to be enabled. Use the getInventoryLocations method to retrieve merchant location keys. Max length : 36",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "merchantLocationKey"
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
          "name": "merchantLocationKey",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "type": "object",
            "additionalProperties": true
          },
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/inventory/v1/location": {
      "operation": "getInventoryLocations",
      "family": "inventory",
      "method": "GET",
      "path": "/sell/inventory/v1/location",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This call retrieves all defined details for every inventory location associated with the seller's account. There are no required parameters for this call and no request payload. However, the One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "The value passed in this query parameter sets the maximum number of records to return per page of data. Although this field is a string, the value passed in this field should be a positive integer value. If this query parameter is not set, up to 100 records will be returned on each page of results. Min : 1",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$"
              },
              "offset": {
                "type": "string",
                "description": "Specifies the number of locations to skip in the result set before returning the first location in the paginated response. Combine offset with the limit query parameter to control the items returned in the response. For example, if you supply an offset of 0 and a limit of 10 , the first page of the response contains the first 10 items from the complete list of items retrieved by the call. If offset is 10 and limit is 20 , the first page of the response contains items 11-30 from the complete result set. Default: 0",
                "maxLength": 262144,
                "pattern": "^(?:0|[1-9][0-9]{0,8})$"
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
          "name": "limit",
          "explode": true
        },
        {
          "location": "query",
          "name": "offset",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/inventory__LocationResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "inventory__LocationResponse",
        "inventory__InventoryLocationResponse",
        "inventory__Location",
        "inventory__Address",
        "inventory__GeoCoordinates",
        "inventory__OperatingHours",
        "inventory__Interval",
        "inventory__SpecialHours",
        "inventory__FulfillmentCenterSpecifications",
        "inventory__SameDayShippingCutOffTimes",
        "inventory__Overrides",
        "inventory__WeeklySchedule"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/inventory/v1/location/{merchantLocationKey}/update_location_details": {
      "operation": "updateInventoryLocation",
      "family": "inventory",
      "method": "POST",
      "path": "/sell/inventory/v1/location/{merchantLocationKey}/update_location_details",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "Use this call to update location details for an existing inventory location. Specify the inventory location you want to update using the merchantLocationKey path parameter. You can update th Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "merchantLocationKey": {
                "type": "string",
                "description": "This path parameter specifies the unique merchant-defined key (ID) for an inventory location that is to be updated. Use the getInventoryLocations method to retrieve merchant location keys. Max length : 36",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "merchantLocationKey"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/inventory__InventoryLocation"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "inventory__InventoryLocation",
        "inventory__LocationDetails",
        "inventory__Address",
        "inventory__GeoCoordinates",
        "inventory__OperatingHours",
        "inventory__Interval",
        "inventory__SpecialHours",
        "inventory__FulfillmentCenterSpecifications",
        "inventory__SameDayShippingCutOffTimes",
        "inventory__Overrides",
        "inventory__WeeklySchedule"
      ],
      "wire": [
        {
          "location": "path",
          "name": "merchantLocationKey",
          "explode": true
        }
      ],
      "responses": {
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/fulfillment/v1/order/{orderId}": {
      "operation": "getOrder",
      "family": "fulfillment",
      "method": "GET",
      "path": "/sell/fulfillment/v1/order/{orderId}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment"
      ],
      "description": "Use this call to retrieve the contents of an order based on its unique identifier, orderId . This value was returned in the getOrders call's orders.orderId field when you searched for orders One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "fieldGroups": {
                "type": "string",
                "description": "This parameter lets you control what is returned in the response. Note: The only presently supported value is TAX_BREAKDOWN . This field group adds addition fields to the response that return a breakdown of taxes and fees.",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "path": {
            "type": "object",
            "properties": {
              "orderId": {
                "type": "string",
                "description": "This path parameter is used to specify the unique identifier of the order being retrieved. Use the getOrders method to retrieve order IDs. Order ID values are also shown in My eBay/Seller Hub. Note: getOrders can return orders up to two years old. Do not provide the orderId for an order created more than two years in the past.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "orderId"
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
          "location": "query",
          "name": "fieldGroups",
          "explode": true
        },
        {
          "location": "path",
          "name": "orderId",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/fulfillment__Order"
          },
          "location": false
        }
      },
      "response_definitions": [
        "fulfillment__Order",
        "fulfillment__Buyer",
        "fulfillment__ExtendedContact",
        "fulfillment__Address",
        "fulfillment__PhoneNumber",
        "fulfillment__TaxAddress",
        "fulfillment__TaxIdentifier",
        "fulfillment__CancelStatus",
        "fulfillment__CancelRequest",
        "fulfillment__FulfillmentStartInstruction",
        "fulfillment__AppointmentDetails",
        "fulfillment__PickupStep",
        "fulfillment__ShippingStep",
        "fulfillment__LineItem",
        "fulfillment__AppliedPromotion",
        "fulfillment__Amount",
        "fulfillment__Property",
        "fulfillment__DeliveryCost",
        "fulfillment__EbayCollectAndRemitTax",
        "fulfillment__EbayTaxReference",
        "fulfillment__EbayCollectedCharges",
        "fulfillment__Charge",
        "fulfillment__GiftDetails",
        "fulfillment__ItemLocation",
        "fulfillment__LineItemFulfillmentInstructions",
        "fulfillment__LinkedOrderLineItem",
        "fulfillment__NameValuePair",
        "fulfillment__TrackingInfo",
        "fulfillment__LineItemProperties",
        "fulfillment__LineItemRefund",
        "fulfillment__Tax",
        "fulfillment__PaymentSummary",
        "fulfillment__Payment",
        "fulfillment__PaymentHold",
        "fulfillment__SellerActionsToRelease",
        "fulfillment__OrderRefund",
        "fulfillment__PricingSummary",
        "fulfillment__Program",
        "fulfillment__PostSaleAuthenticationProgram",
        "fulfillment__EbayShipping",
        "fulfillment__EbayVaultProgram",
        "fulfillment__EbayInternationalShipping",
        "fulfillment__EbayFulfillmentProgram"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/fulfillment/v1/order": {
      "operation": "getOrders",
      "family": "fulfillment",
      "method": "GET",
      "path": "/sell/fulfillment/v1/order",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment"
      ],
      "description": "Use this method to search for and retrieve one or more orders based on their creation date, last modification date, or fulfillment status using the filter parameter. You can alternatively sp One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "fieldGroups": {
                "type": "string",
                "description": "This parameter lets you control what is returned in the response. Note: The only presently supported value is TAX_BREAKDOWN . This field group adds addition fields to the response that return a breakdown of taxes and fees.",
                "maxLength": 262144
              },
              "filter": {
                "type": "string",
                "description": "One or more comma-separated criteria for narrowing down the collection of orders returned by this call. These criteria correspond to specific fields in the response payload. Multiple filter criteria combine to further restrict the results. Note: getOrders can return orders up to two years old. Do not set the creationdate filter to a date beyond two years in the past. Note: If the orderIds parameter is included in the request, the filter parameter will be ignored. The available criteria are as follows: creationdate The time period during which qualifying orders were created (the orders.creationDate field). In the URI, this is expressed as a starting timestamp, with or without an ending timestamp (in brackets). The timestamps are in ISO 8601 format, which uses the 24-hour Universal Coordinated Time (UTC) clock.For example: creationdate:[2016-02-21T08:25:43.511Z..] identifies orders created on or after the given timestamp. creationdate:[2016-02-21T08:25:43.511Z..2016-04-21T08:25:43.511Z] identifies orders created between the given timestamps, inclusive. lastmodifieddate The time period during which qualifying orders were last modified (the orders.modifiedDate field). In the URI, this is expressed as a starting timestamp, with or without an ending timestamp (in brackets). The timestamps are in ISO 8601 format, which uses the 24-hour Universal Coordinated Time (UTC) clock.For example: lastmodifieddate:[2016-05-15T08:25:43.511Z..] identifies orders modified on or after the given timestamp. lastmodifieddate:[2016-05-15T08:25:43.511Z..2016-05-31T08:25:43.511Z] identifies orders modified between the given timestamps, inclusive. Note: If creationdate and lastmodifieddate are both included, only creationdate is used. orderfulfillmentstatus The degree to which qualifying orders have been shipped (the orders.orderFulfillmentStatus field). In the URI, this is expressed as one of the following value combinations: orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS} specifies orders for which no shipping fulfillments have been started, plus orders for which at least one shipping fulfillment has been started but not completed. orderfulfillmentstatus:{FULFILLED|IN_PROGRESS} specifies orders for which all shipping fulfillments have been completed, plus orders for which at least one shipping fulfillment has been started but not completed. Note: The values NOT_STARTED , IN_PROGRESS , and FULFILLED can be used in various combinations, but only the combinations shown here are currently supported. Here is an example of a getOrders call using all of these filters: GET https://api.ebay.com/sell/v1/order? filter= creationdate :%5B2016-03-21T08:25:43.511Z..2016-04-21T08:25:43.511Z%5D, lastmodifieddate :%5B2016-05-15T08:25:43.511Z..%5D, orderfulfillmentstatus :%7BNOT_STARTED%7CIN_PROGRESS%7D Note: This call requires that certain special characters in the URI query string be percent-encoded: &nbsp;&nbsp;&nbsp;&nbsp; [ = %5B &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ] = %5D &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; { = %7B &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | = %7C &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; } = %7D This query filter example uses these codes. For implementation help, refer to eBay API documentation at https://developer.ebay.com/api-docs/sell/fulfillment/types/api:FilterField",
                "maxLength": 262144
              },
              "limit": {
                "type": "string",
                "description": "The number of orders to return per page of the result set. Use this parameter in conjunction with the offset parameter to control the pagination of the output. For example, if offset is set to 10 and limit is set to 10 , the call retrieves orders 11 thru 20 from the result set. If a limit is not set, the limit defaults to 50 and returns up to 50 orders. If a requested limit is more than 200, the call fails and returns an error. Note: This feature employs a zero-based list, where the first item in the list has an offset of 0 . If the orderIds parameter is included in the request, this parameter will be ignored. Maximum: 200 Default: 50",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$"
              },
              "offset": {
                "type": "string",
                "description": "Specifies the number of orders to skip in the result set before returning the first order in the paginated response. Combine offset with the limit query parameter to control the items returned in the response. For example, if you supply an offset of 0 and a limit of 10 , the first page of the response contains the first 10 items from the complete list of items retrieved by the call. If offset is 10 and limit is 20 , the first page of the response contains items 11-30 from the complete result set. Default: 0",
                "maxLength": 262144,
                "pattern": "^(?:0|[1-9][0-9]{0,8})$"
              },
              "orderIds": {
                "type": "string",
                "description": "A comma-separated list of the unique identifiers of the orders to retrieve (maximum 50). If one or more order ID values are specified through the orderIds query parameter, all other query parameters will be ignored. Note: getOrders can return orders up to two years old. Do not provide the orderId for an order created more than two years in the past.",
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
          "name": "fieldGroups",
          "explode": true
        },
        {
          "location": "query",
          "name": "filter",
          "explode": true
        },
        {
          "location": "query",
          "name": "limit",
          "explode": true
        },
        {
          "location": "query",
          "name": "offset",
          "explode": true
        },
        {
          "location": "query",
          "name": "orderIds",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/fulfillment__OrderSearchPagedCollection"
          },
          "location": false
        }
      },
      "response_definitions": [
        "fulfillment__OrderSearchPagedCollection",
        "fulfillment__Order",
        "fulfillment__Buyer",
        "fulfillment__ExtendedContact",
        "fulfillment__Address",
        "fulfillment__PhoneNumber",
        "fulfillment__TaxAddress",
        "fulfillment__TaxIdentifier",
        "fulfillment__CancelStatus",
        "fulfillment__CancelRequest",
        "fulfillment__FulfillmentStartInstruction",
        "fulfillment__AppointmentDetails",
        "fulfillment__PickupStep",
        "fulfillment__ShippingStep",
        "fulfillment__LineItem",
        "fulfillment__AppliedPromotion",
        "fulfillment__Amount",
        "fulfillment__Property",
        "fulfillment__DeliveryCost",
        "fulfillment__EbayCollectAndRemitTax",
        "fulfillment__EbayTaxReference",
        "fulfillment__EbayCollectedCharges",
        "fulfillment__Charge",
        "fulfillment__GiftDetails",
        "fulfillment__ItemLocation",
        "fulfillment__LineItemFulfillmentInstructions",
        "fulfillment__LinkedOrderLineItem",
        "fulfillment__NameValuePair",
        "fulfillment__TrackingInfo",
        "fulfillment__LineItemProperties",
        "fulfillment__LineItemRefund",
        "fulfillment__Tax",
        "fulfillment__PaymentSummary",
        "fulfillment__Payment",
        "fulfillment__PaymentHold",
        "fulfillment__SellerActionsToRelease",
        "fulfillment__OrderRefund",
        "fulfillment__PricingSummary",
        "fulfillment__Program",
        "fulfillment__PostSaleAuthenticationProgram",
        "fulfillment__EbayShipping",
        "fulfillment__EbayVaultProgram",
        "fulfillment__EbayInternationalShipping",
        "fulfillment__EbayFulfillmentProgram",
        "fulfillment__Error",
        "fulfillment__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "GET /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment": {
      "operation": "getShippingFulfillments",
      "family": "fulfillment",
      "method": "GET",
      "path": "/sell/fulfillment/v1/order/{orderId}/shipping_fulfillment",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment"
      ],
      "description": "Use this call to retrieve the contents of all fulfillments currently defined for a specified order based on the order's unique identifier, orderId . This value is returned in the getOrders c One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "orderId": {
                "type": "string",
                "description": "This path parameter is used to specify the unique identifier of the order associated with the shipping fulfillments being retrieved. Use the getOrders method to retrieve order IDs. Order ID values are also shown in My eBay/Seller Hub.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "orderId"
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
          "name": "orderId",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/fulfillment__ShippingFulfillmentPagedCollection"
          },
          "location": false
        }
      },
      "response_definitions": [
        "fulfillment__ShippingFulfillmentPagedCollection",
        "fulfillment__ShippingFulfillment",
        "fulfillment__LineItemReference",
        "fulfillment__Error",
        "fulfillment__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment": {
      "operation": "createShippingFulfillment",
      "family": "fulfillment",
      "method": "POST",
      "path": "/sell/fulfillment/v1/order/{orderId}/shipping_fulfillment",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment"
      ],
      "description": "When you group an order's line items into one or more packages, each package requires a corresponding plan for handling, addressing, and shipping; this is a shipping fulfillment . For each p Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "orderId": {
                "type": "string",
                "description": "This path parameter is used to specify the unique identifier of the order associated with the shipping fulfillment being created. Use the getOrders method to retrieve order IDs.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "orderId"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/fulfillment__ShippingFulfillmentDetails"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "fulfillment__ShippingFulfillmentDetails",
        "fulfillment__LineItemReference"
      ],
      "wire": [
        {
          "location": "path",
          "name": "orderId",
          "explode": true
        }
      ],
      "responses": {
        "201": {
          "schema": {
            "type": "object",
            "additionalProperties": true
          },
          "location": true
        }
      },
      "response_definitions": [],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment/{fulfillmentId}": {
      "operation": "getShippingFulfillment",
      "family": "fulfillment",
      "method": "GET",
      "path": "/sell/fulfillment/v1/order/{orderId}/shipping_fulfillment/{fulfillmentId}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment"
      ],
      "description": "Use this call to retrieve the contents of a fulfillment based on its unique identifier, fulfillmentId (combined with the associated order's orderId ). The fulfillmentId value was originally  One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "fulfillmentId": {
                "type": "string",
                "description": "This path parameter is used to specify the unique identifier of the shipping fulfillment being retrieved. Use the getShippingFulfillments method to retrieved fulfillment IDs.",
                "maxLength": 262144,
                "minLength": 1
              },
              "orderId": {
                "type": "string",
                "description": "This path parameter is used to specify the unique identifier of the order associated with the shipping fulfillment being retrieved. Use the getOrders method to retrieve order IDs. Order ID values are also shown in My eBay/Seller Hub.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "fulfillmentId",
              "orderId"
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
          "name": "fulfillmentId",
          "explode": true
        },
        {
          "location": "path",
          "name": "orderId",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/fulfillment__ShippingFulfillment"
          },
          "location": false
        }
      },
      "response_definitions": [
        "fulfillment__ShippingFulfillment",
        "fulfillment__LineItemReference"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /commerce/catalog/v1_beta/product/{epid}": {
      "operation": "getProduct",
      "family": "catalog",
      "method": "GET",
      "path": "/commerce/catalog/v1_beta/product/{epid}",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This method retrieves details of the catalog product identified by the eBay product identifier (ePID) specified in the request. These details include the product's title and description, asp One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "epid": {
                "type": "string",
                "description": "The eBay product identifier (ePID) of the product being requested. This value can be discovered by issuing the search method and examining the value of the productSummaries.epid field for the desired returned product summary.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "epid"
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
          "name": "epid",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/catalog__Product"
          },
          "location": false
        }
      },
      "response_definitions": [
        "catalog__Product",
        "catalog__Image",
        "catalog__Aspect"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /commerce/catalog/v1_beta/product_summary/search": {
      "operation": "search",
      "family": "catalog",
      "method": "GET",
      "path": "/commerce/catalog/v1_beta/product_summary/search",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This method searches for and retrieves summaries of one or more products in the eBay catalog that match the search criteria provided by a seller. The seller can use the summaries to select t One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "aspect_filter": {
                "type": "string",
                "description": "An eBay category and one or more aspects of that category, with the values that can be used to narrow down the collection of products returned by this call. Aspects are product attributes that can represent different types of information for different products. Every product has aspects, but different products have different sets of aspects. You can determine appropriate values for the aspects by first submitting this method without this parameter. It will return either the productSummaries.aspects container, the refinement.aspectDistributions container, or both, depending on the value of the fieldgroups parameter in the request. The productSummaries.aspects container provides the category aspects and their values that are associated with each returned product. The refinement.aspectDistributions container provides information about the distribution of values of the set of category aspects associated with the specified categories. In both cases sellers can select from among the returned aspects to use with this parameter. Note: You can also use the Taxonomy API's getItemAspectsForCategory method to retrieve detailed information about aspects and their values that are appropriate for your selected category. The syntax for the aspect_filter parameter is as follows (on several lines for readability; categoryId is required): aspect_filter=categoryId: category_id , aspect1 :{ valueA | valueB |...}, aspect2 :{ valueC | valueD |...},. A matching product must be within the specified category, and it must have least one of the values identified for every specified aspect. Note: Aspect names and values are case sensitive. Here is an example of an aspect_filter parameter in which 9355 is the category ID, Color is an aspect of that category, and Black and White are possible values of that aspect (on several lines for readability): GET https://api.ebay.com/commerce/catalog/v1_beta/product_summary/search? aspect_filter=categoryId:9355,Color:{White|Black} Here is the aspect_filter with required URL encoding and a second aspect (on several lines for readability): GET https://api.ebay.com/commerce/catalog/v1_beta/product_summary/search? aspect_filter=categoryId:9355,Color:%7BWhite%7CBlack%7D, Storage%20Capacity:%128GB%7C256GB%7D Note: You cannot use the aspect_filter parameter in the same method with either the gtin parameter or the mpn parameter. For implementation help, refer to eBay API documentation at https://developer.ebay.com/api-docs/commerce/catalog/types/catal:AspectFilter",
                "maxLength": 262144
              },
              "category_ids": {
                "type": "string",
                "description": "Important: Currently, only the first category_id value is accepted. One or more comma-separated category identifiers for narrowing down the collection of products returned by this call. Note: This parameter requires a valid category ID value. You can use the Taxonomy API's getCategorySuggestions method to retrieve appropriate category IDs for your product based on keywords. The syntax for this parameter is as follows: category_ids= category_id1 , category_id2 ,. Here is an example of a method with the category_ids parameter: GET https://api.ebay.com/commerce/catalog/v1_beta/product_summary/search? category_ids=178893 Note: Although all query parameters are optional, this method must include at least the q parameter, or the category_ids , gtin , or mpn parameter with a valid value. If you provide only the category_ids parameter, you cannot specify a top-level (L1) category.",
                "maxLength": 262144
              },
              "fieldgroups": {
                "type": "string",
                "description": "The type of information to return in the response. Important: This parameter may not produce valid results if you also provide more than one value for the category_ids parameter. It is recommended that you avoid using this combination. Valid Values: ASPECT_REFINEMENTS &mdash; This returns the refinement container, which includes the category aspect and aspect value distributions that apply to the returned products. For example, if you searched for Ford Mustang , some of the category aspects might be Model Year , Exterior Color , Vehicle Mileage , and so on. Note: Aspects are category specific. FULL &mdash; This returns all the refinement containers and all the matching products. This value overrides the other values, which will be ignored. MATCHING_PRODUCTS &mdash; This returns summaries for all products that match the values you provide for the q and category_ids parameters. This does not affect your use of the ASPECT_REFINEMENTS value, which you can use in the same call. Code so that your app gracefully handles any future changes to this list. Default: MATCHING_PRODUCTS",
                "maxLength": 262144
              },
              "gtin": {
                "type": "string",
                "description": "A string consisting of one or more comma-separated Global Trade Item Numbers (GTINs) that identify products to search for. Currently the GTIN values can include EAN, ISBN, and UPC identifier types. Note: Although all query parameters are optional, this method must include at least the q parameter, or the category_ids , gtin , or mpn parameter with a valid value. You cannot use the gtin parameter in the same method with either the q parameter or the aspect_filter parameter.",
                "maxLength": 262144
              },
              "limit": {
                "type": "string",
                "description": "The number of product summaries to return. This is the result set , a subset of the full collection of products that match the search or filter criteria of this call. Maximum: 200 Default: 50",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$"
              },
              "mpn": {
                "type": "string",
                "description": "A string consisting of one or more comma-separated Manufacturer Part Numbers (MPNs) that identify products to search for. This method will return all products that have one of the specified MPNs. MPNs are defined by manufacturers for their own products, and are therefore certain to be unique only within a given brand. However, many MPNs do turn out to be globally unique. Note: Although all query parameters are optional, this method must include at least the q parameter, or the category_ids , gtin , or mpn parameter with a valid value. You cannot use the mpn parameter in the same method with either the q parameter or the aspect_filter parameter.",
                "maxLength": 262144
              },
              "offset": {
                "type": "string",
                "description": "This parameter is reserved for internal or future use.",
                "maxLength": 262144
              },
              "q": {
                "type": "string",
                "description": "A string consisting of one or more keywords to use to search for products in the eBay catalog. Note: This method searches the following product record fields: title , description , brand , and aspects.localizedName , which do not include product IDs. Wildcard characters (e.g. * ) are not allowed. The keywords are handled as follows: If the keywords are separated by a comma (e.g. iPhone,256GB ), the query returns products that have iPhone AND 256GB . If the keywords are separated by a space (e.g. \"iPhone&nbsp;ipad\" or \"iPhone,&nbsp;ipad\" ), the query ignores any commas and returns products that have iPhone OR iPad . Note: Although all query parameters are optional, this method must include at least the q parameter, or the category_ids , gtin , or mpn parameter with a valid value. You cannot use the q parameter in the same method with either the gtin parameter or the mpn parameter.",
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
          "name": "aspect_filter",
          "explode": true
        },
        {
          "location": "query",
          "name": "category_ids",
          "explode": true
        },
        {
          "location": "query",
          "name": "fieldgroups",
          "explode": true
        },
        {
          "location": "query",
          "name": "gtin",
          "explode": true
        },
        {
          "location": "query",
          "name": "limit",
          "explode": true
        },
        {
          "location": "query",
          "name": "mpn",
          "explode": true
        },
        {
          "location": "query",
          "name": "offset",
          "explode": true
        },
        {
          "location": "query",
          "name": "q",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/catalog__ProductSearchResponse"
          },
          "location": false
        },
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [
        "catalog__ProductSearchResponse",
        "catalog__ProductSummary",
        "catalog__Image",
        "catalog__Aspect",
        "catalog__Refinement",
        "catalog__AspectDistribution",
        "catalog__AspectValueDistribution"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_item_condition_policies": {
      "operation": "getItemConditionPolicies",
      "family": "metadata",
      "method": "GET",
      "path": "/sell/metadata/v1/marketplace/{marketplace_id}/get_item_condition_policies",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This method returns item condition metadata on one, multiple, or all eBay categories on an eBay marketplace. This metadata consists of the different item conditions (with IDs) that an eBay c One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "filter": {
                "type": "string",
                "description": "This query parameter limits the response by returning policy information for only the selected sections of the category tree. Supply categoryId values for the sections of the tree you want returned. When you specify a categoryId value, the returned category tree includes the policies for that parent node, plus the policies for any leaf nodes below that parent node. The parameter takes a list of categoryId values and you can specify up to 50 separate category IDs. Separate multiple values with a pipe character ('|'). If you specify more than 50 categoryId values, eBay returns the policies for the first 50 IDs and a warning that not all categories were returned. Example: filter=categoryIds:{100|101|102} Note that you must URL-encode the parameter list, which results in the following filter for the above example: &nbsp;&nbsp; filter=categoryIds%3A%7B100%7C101%7C102%7D",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "path": {
            "type": "object",
            "properties": {
              "marketplace_id": {
                "type": "string",
                "description": "This path parameter specifies the eBay marketplace for which policy information is retrieved. See HTTP Request Headers for a list of supported eBay marketplace ID values.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "marketplace_id"
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
          "location": "query",
          "name": "filter",
          "explode": true
        },
        {
          "location": "path",
          "name": "marketplace_id",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/metadata__ItemConditionPolicyResponse"
          },
          "location": false
        },
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [
        "metadata__ItemConditionPolicyResponse",
        "metadata__ItemConditionPolicy",
        "metadata__ItemCondition",
        "metadata__ItemConditionDescriptor",
        "metadata__ItemConditionDescriptorConstraint",
        "metadata__ItemConditionDescriptorValue",
        "metadata__ItemConditionDescriptorValueConstraint",
        "metadata__Error",
        "metadata__ErrorParameter"
      ],
      "error_paths": [],
      "error_prose_paths": [
        [
          "warnings",
          "*",
          "message"
        ],
        [
          "warnings",
          "*",
          "longMessage"
        ],
        [
          "warnings",
          "*",
          "parameters"
        ]
      ],
      "status_paths": []
    },
    "GET /sell/negotiation/v1/find_eligible_items": {
      "operation": "findEligibleItems",
      "family": "negotiation",
      "method": "GET",
      "path": "/sell/negotiation/v1/find_eligible_items",
      "risk": "R",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This method evaluates a seller's current listings and returns the set of IDs that are eligible for a seller-initiated discount offer to a buyer. A listing ID is returned only when one or mor One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "This query parameter specifies the maximum number of items to return from the result set on a page in the paginated response. Minimum: 1 Maximum: 200 Default: 10",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$"
              },
              "offset": {
                "type": "string",
                "description": "This query parameter specifies the number of results to skip in the result set before returning the first result in the paginated response. Combine offset with the limit query parameter to control the items returned in the response. For example, if you supply an offset of 0 and a limit of 10 , the first page of the response contains the first 10 results from the complete list of items retrieved by the call. If offset is 10 and limit is 20 , the first page of the response contains items 11-30 from the complete result set. Default: 0",
                "maxLength": 262144,
                "pattern": "^(?:0|[1-9][0-9]{0,8})$"
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
          "name": "limit",
          "explode": true
        },
        {
          "location": "query",
          "name": "offset",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/negotiation__PagedEligibleItemCollection"
          },
          "location": false
        },
        "204": {
          "schema": null,
          "location": false
        }
      },
      "response_definitions": [
        "negotiation__PagedEligibleItemCollection",
        "negotiation__EligibleItem"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    },
    "POST /sell/negotiation/v1/send_offer_to_interested_buyers": {
      "operation": "sendOfferToInterestedBuyers",
      "family": "negotiation",
      "method": "POST",
      "path": "/sell/negotiation/v1/send_offer_to_interested_buyers",
      "risk": "H",
      "scopes": [
        "https://api.ebay.com/oauth/api_scope/sell.inventory"
      ],
      "description": "This method sends eligible buyers offers to purchase items in a listing at a discount. When a buyer has shown interest in a listing, they become \"eligible\" to receive a seller-initiated offe Acknowledgement is not completion; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/negotiation__CreateOffersRequest"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "input_definitions": [
        "negotiation__CreateOffersRequest",
        "negotiation__TimeDuration",
        "negotiation__OfferedItem",
        "negotiation__Amount"
      ],
      "wire": [],
      "responses": {
        "200": {
          "schema": {
            "$ref": "#/$defs/negotiation__SendOfferToInterestedBuyersCollectionResponse"
          },
          "location": false
        }
      },
      "response_definitions": [
        "negotiation__SendOfferToInterestedBuyersCollectionResponse",
        "negotiation__Offer",
        "negotiation__User",
        "negotiation__TimeDuration",
        "negotiation__OfferedItem",
        "negotiation__Amount"
      ],
      "error_paths": [],
      "error_prose_paths": [],
      "status_paths": []
    }
  },
  "definitions": {
    "output": {
      "account__CustomPolicyResponse": {
        "type": "object",
        "properties": {
          "customPolicies": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__CompactCustomPolicyResponse"
            }
          },
          "href": {
            "type": "string"
          },
          "limit": {
            "type": "integer"
          },
          "next": {
            "type": "string"
          },
          "offset": {
            "type": "integer"
          },
          "prev": {
            "type": "string"
          },
          "total": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "account__CompactCustomPolicyResponse": {
        "type": "object",
        "properties": {
          "customPolicyId": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "policyType": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__CustomPolicy": {
        "type": "object",
        "properties": {
          "customPolicyId": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "policyType": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__SetFulfillmentPolicyResponse": {
        "type": "object",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            }
          },
          "description": {
            "type": "string"
          },
          "freightShipping": {
            "type": "boolean"
          },
          "fulfillmentPolicyId": {
            "type": "string"
          },
          "globalShipping": {
            "type": "boolean"
          },
          "handlingTime": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "localPickup": {
            "type": "boolean"
          },
          "marketplaceId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "pickupDropOff": {
            "type": "boolean"
          },
          "shippingOptions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__ShippingOption"
            }
          },
          "shipToLocations": {
            "$ref": "#/$defs/account__RegionSet"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "account__CategoryType": {
        "type": "object",
        "properties": {
          "default": {
            "type": "boolean"
          },
          "name": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__TimeDuration": {
        "type": "object",
        "properties": {
          "unit": {
            "type": "string"
          },
          "value": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "account__ShippingOption": {
        "type": "object",
        "properties": {
          "costType": {
            "type": "string"
          },
          "insuranceFee": {
            "$ref": "#/$defs/account__Amount"
          },
          "insuranceOffered": {
            "type": "boolean"
          },
          "optionType": {
            "type": "string"
          },
          "packageHandlingCost": {
            "$ref": "#/$defs/account__Amount"
          },
          "rateTableId": {
            "type": "string"
          },
          "shippingDiscountProfileId": {
            "type": "string"
          },
          "shippingPromotionOffered": {
            "type": "boolean"
          },
          "shippingServices": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__ShippingService"
            }
          }
        },
        "additionalProperties": true
      },
      "account__Amount": {
        "type": "object",
        "properties": {
          "currency": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__ShippingService": {
        "type": "object",
        "properties": {
          "additionalShippingCost": {
            "$ref": "#/$defs/account__Amount"
          },
          "buyerResponsibleForPickup": {
            "type": "boolean"
          },
          "buyerResponsibleForShipping": {
            "type": "boolean"
          },
          "freeShipping": {
            "type": "boolean"
          },
          "shippingCarrierCode": {
            "type": "string"
          },
          "shippingCost": {
            "$ref": "#/$defs/account__Amount"
          },
          "shippingServiceCode": {
            "type": "string"
          },
          "shipToLocations": {
            "$ref": "#/$defs/account__RegionSet"
          },
          "sortOrder": {
            "type": "integer"
          },
          "surcharge": {
            "$ref": "#/$defs/account__Amount"
          }
        },
        "additionalProperties": true
      },
      "account__RegionSet": {
        "type": "object",
        "properties": {
          "regionExcluded": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__Region"
            }
          },
          "regionIncluded": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__Region"
            }
          }
        },
        "additionalProperties": true
      },
      "account__Region": {
        "type": "object",
        "properties": {
          "regionName": {
            "type": "string"
          },
          "regionType": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__Error": {
        "type": "object",
        "properties": {
          "category": {
            "type": "string"
          },
          "domain": {
            "type": "string"
          },
          "errorId": {
            "type": "integer"
          },
          "inputRefIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "longMessage": {
            "type": "string"
          },
          "message": {
            "type": "string"
          },
          "outputRefIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "parameters": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__ErrorParameter"
            }
          },
          "subdomain": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__ErrorParameter": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__FulfillmentPolicy": {
        "type": "object",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            }
          },
          "description": {
            "type": "string"
          },
          "freightShipping": {
            "type": "boolean"
          },
          "fulfillmentPolicyId": {
            "type": "string"
          },
          "globalShipping": {
            "type": "boolean"
          },
          "handlingTime": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "localPickup": {
            "type": "boolean"
          },
          "marketplaceId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "pickupDropOff": {
            "type": "boolean"
          },
          "shippingOptions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__ShippingOption"
            }
          },
          "shipToLocations": {
            "$ref": "#/$defs/account__RegionSet"
          }
        },
        "additionalProperties": true
      },
      "account__FulfillmentPolicyResponse": {
        "type": "object",
        "properties": {
          "fulfillmentPolicies": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__FulfillmentPolicy"
            }
          },
          "href": {
            "type": "string"
          },
          "limit": {
            "type": "integer"
          },
          "next": {
            "type": "string"
          },
          "offset": {
            "type": "integer"
          },
          "prev": {
            "type": "string"
          },
          "total": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "account__PaymentPolicyResponse": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          },
          "limit": {
            "type": "integer"
          },
          "next": {
            "type": "string"
          },
          "offset": {
            "type": "integer"
          },
          "paymentPolicies": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__PaymentPolicy"
            }
          },
          "prev": {
            "type": "string"
          },
          "total": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "account__PaymentPolicy": {
        "type": "object",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            }
          },
          "deposit": {
            "$ref": "#/$defs/account__Deposit"
          },
          "description": {
            "type": "string"
          },
          "fullPaymentDueIn": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "immediatePay": {
            "type": "boolean"
          },
          "marketplaceId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "paymentInstructions": {
            "type": "string"
          },
          "paymentMethods": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__PaymentMethod"
            }
          },
          "paymentPolicyId": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__Deposit": {
        "type": "object",
        "properties": {
          "amount": {
            "$ref": "#/$defs/account__Amount"
          },
          "dueIn": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "paymentMethods": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__PaymentMethod"
            }
          }
        },
        "additionalProperties": true
      },
      "account__PaymentMethod": {
        "type": "object",
        "properties": {
          "brands": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "paymentMethodType": {
            "type": "string"
          },
          "recipientAccountReference": {
            "$ref": "#/$defs/account__RecipientAccountReference"
          }
        },
        "additionalProperties": true
      },
      "account__RecipientAccountReference": {
        "type": "object",
        "properties": {
          "referenceId": {
            "type": "string"
          },
          "referenceType": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__SetPaymentPolicyResponse": {
        "type": "object",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            }
          },
          "deposit": {
            "$ref": "#/$defs/account__Deposit"
          },
          "description": {
            "type": "string"
          },
          "fullPaymentDueIn": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "immediatePay": {
            "type": "boolean"
          },
          "marketplaceId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "paymentInstructions": {
            "type": "string"
          },
          "paymentMethods": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__PaymentMethod"
            }
          },
          "paymentPolicyId": {
            "type": "string"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "account__PaymentsProgramResponse": {
        "type": "object",
        "properties": {
          "marketplaceId": {
            "type": "string"
          },
          "paymentsProgramType": {
            "type": "string"
          },
          "status": {
            "type": "string"
          },
          "wasPreviouslyOptedIn": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "account__PaymentsProgramOnboardingResponse": {
        "type": "object",
        "properties": {
          "onboardingStatus": {
            "type": "string"
          },
          "steps": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__PaymentsProgramOnboardingSteps"
            }
          }
        },
        "additionalProperties": true
      },
      "account__PaymentsProgramOnboardingSteps": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "status": {
            "type": "string"
          },
          "webUrl": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__SellingPrivileges": {
        "type": "object",
        "properties": {
          "sellerRegistrationCompleted": {
            "type": "boolean"
          },
          "sellingLimit": {
            "$ref": "#/$defs/account__SellingLimit"
          }
        },
        "additionalProperties": true
      },
      "account__SellingLimit": {
        "type": "object",
        "properties": {
          "amount": {
            "$ref": "#/$defs/account__Amount"
          },
          "quantity": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "account__Programs": {
        "type": "object",
        "properties": {
          "programs": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__Program"
            }
          }
        },
        "additionalProperties": true
      },
      "account__Program": {
        "type": "object",
        "properties": {
          "programType": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__RateTableResponse": {
        "type": "object",
        "properties": {
          "rateTables": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__RateTable"
            }
          }
        },
        "additionalProperties": true
      },
      "account__RateTable": {
        "type": "object",
        "properties": {
          "countryCode": {
            "type": "string"
          },
          "locality": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "rateTableId": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__ReturnPolicyResponse": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          },
          "limit": {
            "type": "integer"
          },
          "next": {
            "type": "string"
          },
          "offset": {
            "type": "integer"
          },
          "prev": {
            "type": "string"
          },
          "returnPolicies": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__ReturnPolicy"
            }
          },
          "total": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "account__ReturnPolicy": {
        "type": "object",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            }
          },
          "description": {
            "type": "string"
          },
          "extendedHolidayReturnsOffered": {
            "type": "boolean"
          },
          "internationalOverride": {
            "$ref": "#/$defs/account__InternationalReturnOverrideType"
          },
          "marketplaceId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "refundMethod": {
            "type": "string"
          },
          "restockingFeePercentage": {
            "type": "string"
          },
          "returnInstructions": {
            "type": "string"
          },
          "returnMethod": {
            "type": "string"
          },
          "returnPeriod": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "returnPolicyId": {
            "type": "string"
          },
          "returnsAccepted": {
            "type": "boolean"
          },
          "returnShippingCostPayer": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__InternationalReturnOverrideType": {
        "type": "object",
        "properties": {
          "returnMethod": {
            "type": "string"
          },
          "returnPeriod": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "returnsAccepted": {
            "type": "boolean"
          },
          "returnShippingCostPayer": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account__SetReturnPolicyResponse": {
        "type": "object",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            }
          },
          "description": {
            "type": "string"
          },
          "extendedHolidayReturnsOffered": {
            "type": "boolean"
          },
          "internationalOverride": {
            "$ref": "#/$defs/account__InternationalReturnOverrideType"
          },
          "marketplaceId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "refundMethod": {
            "type": "string"
          },
          "restockingFeePercentage": {
            "type": "string"
          },
          "returnInstructions": {
            "type": "string"
          },
          "returnMethod": {
            "type": "string"
          },
          "returnPeriod": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "returnPolicyId": {
            "type": "string"
          },
          "returnsAccepted": {
            "type": "boolean"
          },
          "returnShippingCostPayer": {
            "type": "string"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "account__UpdatedSalesTaxResponse": {
        "type": "object",
        "properties": {
          "updatedSalesTaxEntries": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__UpdatedSalesTaxEntry"
            }
          }
        },
        "additionalProperties": true
      },
      "account__UpdatedSalesTaxEntry": {
        "type": "object",
        "properties": {
          "countryCode": {
            "type": "string"
          },
          "jurisdictionId": {
            "type": "string"
          },
          "statusCode": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "account__SalesTax": {
        "type": "object",
        "properties": {
          "countryCode": {
            "type": "string"
          },
          "salesTaxJurisdictionId": {
            "type": "string"
          },
          "salesTaxPercentage": {
            "type": "string"
          },
          "shippingAndHandlingTaxed": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "account__SalesTaxes": {
        "type": "object",
        "properties": {
          "salesTaxes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__SalesTax"
            }
          }
        },
        "additionalProperties": true
      },
      "account__SubscriptionResponse": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          },
          "limit": {
            "type": "integer"
          },
          "next": {
            "type": "string"
          },
          "subscriptions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__Subscription"
            }
          },
          "total": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "account__Subscription": {
        "type": "object",
        "properties": {
          "marketplaceId": {
            "type": "string"
          },
          "subscriptionId": {
            "type": "string"
          },
          "subscriptionLevel": {
            "type": "string"
          },
          "subscriptionType": {
            "type": "string"
          },
          "term": {
            "$ref": "#/$defs/account__TimeDuration"
          }
        },
        "additionalProperties": true
      },
      "account__SellerEligibilityMultiProgramResponse": {
        "type": "object",
        "properties": {
          "advertisingEligibility": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account__SellerEligibilityResponse"
            }
          }
        },
        "additionalProperties": true
      },
      "account__SellerEligibilityResponse": {
        "type": "object",
        "properties": {
          "programType": {
            "type": "string"
          },
          "reason": {
            "type": "string"
          },
          "status": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account_v2__RateTableDetails": {
        "type": "object",
        "properties": {
          "marketplaceId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "rates": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/account_v2__Rate"
            }
          },
          "rateTableBasis": {
            "type": "string"
          },
          "rateTableId": {
            "type": "string"
          },
          "shippingOptionType": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account_v2__Rate": {
        "type": "object",
        "properties": {
          "additionalCost": {
            "$ref": "#/$defs/account_v2__Amount"
          },
          "rateId": {
            "type": "string"
          },
          "shippingCategory": {
            "type": "string"
          },
          "shippingCost": {
            "$ref": "#/$defs/account_v2__Amount"
          },
          "shippingRegionNames": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "shippingServiceCode": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "account_v2__Amount": {
        "type": "object",
        "properties": {
          "currency": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__BulkInventoryItemResponse": {
        "type": "object",
        "properties": {
          "responses": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__InventoryItemResponse"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__InventoryItemResponse": {
        "type": "object",
        "properties": {
          "errors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          },
          "locale": {
            "type": "string"
          },
          "sku": {
            "type": "string"
          },
          "statusCode": {
            "type": "integer"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__Error": {
        "type": "object",
        "properties": {
          "category": {
            "type": "string"
          },
          "domain": {
            "type": "string"
          },
          "errorId": {
            "type": "integer"
          },
          "inputRefIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "longMessage": {
            "type": "string"
          },
          "message": {
            "type": "string"
          },
          "outputRefIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "parameters": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__ErrorParameter"
            }
          },
          "subdomain": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__ErrorParameter": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__BulkGetInventoryItemResponse": {
        "type": "object",
        "properties": {
          "responses": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__GetInventoryItemResponse"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__GetInventoryItemResponse": {
        "type": "object",
        "properties": {
          "errors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          },
          "inventoryItem": {
            "$ref": "#/$defs/inventory__InventoryItemWithSkuLocaleGroupKeys"
          },
          "sku": {
            "type": "string"
          },
          "statusCode": {
            "type": "integer"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__InventoryItemWithSkuLocaleGroupKeys": {
        "type": "object",
        "properties": {
          "availability": {
            "$ref": "#/$defs/inventory__AvailabilityWithAll"
          },
          "condition": {
            "type": "string"
          },
          "conditionDescription": {
            "type": "string"
          },
          "conditionDescriptors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__ConditionDescriptor"
            }
          },
          "inventoryItemGroupKeys": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "locale": {
            "type": "string"
          },
          "packageWeightAndSize": {
            "$ref": "#/$defs/inventory__PackageWeightAndSize"
          },
          "product": {
            "$ref": "#/$defs/inventory__Product"
          },
          "sku": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__AvailabilityWithAll": {
        "type": "object",
        "properties": {
          "pickupAtLocationAvailability": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__PickupAtLocationAvailability"
            }
          },
          "shipToLocationAvailability": {
            "$ref": "#/$defs/inventory__ShipToLocationAvailabilityWithAll"
          }
        },
        "additionalProperties": true
      },
      "inventory__PickupAtLocationAvailability": {
        "type": "object",
        "properties": {
          "availabilityType": {
            "type": "string"
          },
          "fulfillmentTime": {
            "$ref": "#/$defs/inventory__TimeDuration"
          },
          "merchantLocationKey": {
            "type": "string"
          },
          "quantity": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "inventory__TimeDuration": {
        "type": "object",
        "properties": {
          "unit": {
            "type": "string"
          },
          "value": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "inventory__ShipToLocationAvailabilityWithAll": {
        "type": "object",
        "properties": {
          "allocationByFormat": {
            "$ref": "#/$defs/inventory__FormatAllocation"
          },
          "availabilityDistributions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__AvailabilityDistribution"
            }
          },
          "quantity": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "inventory__FormatAllocation": {
        "type": "object",
        "properties": {
          "auction": {
            "type": "integer"
          },
          "fixedPrice": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "inventory__AvailabilityDistribution": {
        "type": "object",
        "properties": {
          "fulfillmentTime": {
            "$ref": "#/$defs/inventory__TimeDuration"
          },
          "merchantLocationKey": {
            "type": "string"
          },
          "quantity": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "inventory__ConditionDescriptor": {
        "type": "object",
        "properties": {
          "additionalInfo": {
            "type": "string"
          },
          "name": {
            "type": "string"
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
      "inventory__PackageWeightAndSize": {
        "type": "object",
        "properties": {
          "dimensions": {
            "$ref": "#/$defs/inventory__Dimension"
          },
          "packageType": {
            "type": "string"
          },
          "shippingIrregular": {
            "type": "boolean"
          },
          "weight": {
            "$ref": "#/$defs/inventory__Weight"
          }
        },
        "additionalProperties": true
      },
      "inventory__Dimension": {
        "type": "object",
        "properties": {
          "height": {
            "type": "number"
          },
          "length": {
            "type": "number"
          },
          "unit": {
            "type": "string"
          },
          "width": {
            "type": "number"
          }
        },
        "additionalProperties": true
      },
      "inventory__Weight": {
        "type": "object",
        "properties": {
          "unit": {
            "type": "string"
          },
          "value": {
            "type": "number"
          }
        },
        "additionalProperties": true
      },
      "inventory__Product": {
        "type": "object",
        "properties": {
          "aspects": {
            "type": "object",
            "additionalProperties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "brand": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "ean": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "epid": {
            "type": "string"
          },
          "imageUrls": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "isbn": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "mpn": {
            "type": "string"
          },
          "subtitle": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "upc": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "videoIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__BulkPriceQuantityResponse": {
        "type": "object",
        "properties": {
          "responses": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__PriceQuantityResponse"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__PriceQuantityResponse": {
        "type": "object",
        "properties": {
          "errors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          },
          "offerId": {
            "type": "string"
          },
          "sku": {
            "type": "string"
          },
          "statusCode": {
            "type": "integer"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__InventoryItemWithSkuLocaleGroupid": {
        "type": "object",
        "properties": {
          "availability": {
            "$ref": "#/$defs/inventory__AvailabilityWithAll"
          },
          "condition": {
            "type": "string"
          },
          "conditionDescription": {
            "type": "string"
          },
          "conditionDescriptors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__ConditionDescriptor"
            }
          },
          "groupIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "inventoryItemGroupKeys": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "locale": {
            "type": "string"
          },
          "packageWeightAndSize": {
            "$ref": "#/$defs/inventory__PackageWeightAndSize"
          },
          "product": {
            "$ref": "#/$defs/inventory__Product"
          },
          "sku": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__BaseResponse": {
        "type": "object",
        "properties": {
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__InventoryItems": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          },
          "inventoryItems": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__InventoryItemWithSkuLocaleGroupid"
            }
          },
          "limit": {
            "type": "integer"
          },
          "next": {
            "type": "string"
          },
          "prev": {
            "type": "string"
          },
          "size": {
            "type": "integer"
          },
          "total": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "inventory__Compatibility": {
        "type": "object",
        "properties": {
          "compatibleProducts": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__CompatibleProduct"
            }
          },
          "sku": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__CompatibleProduct": {
        "type": "object",
        "properties": {
          "compatibilityProperties": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__NameValueList"
            }
          },
          "notes": {
            "type": "string"
          },
          "productFamilyProperties": {
            "$ref": "#/$defs/inventory__ProductFamilyProperties"
          },
          "productIdentifier": {
            "$ref": "#/$defs/inventory__ProductIdentifier"
          }
        },
        "additionalProperties": true
      },
      "inventory__NameValueList": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__ProductFamilyProperties": {
        "type": "object",
        "properties": {
          "engine": {
            "type": "string"
          },
          "make": {
            "type": "string"
          },
          "model": {
            "type": "string"
          },
          "trim": {
            "type": "string"
          },
          "year": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__ProductIdentifier": {
        "type": "object",
        "properties": {
          "epid": {
            "type": "string"
          },
          "gtin": {
            "type": "string"
          },
          "ktype": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__InventoryItemGroup": {
        "type": "object",
        "properties": {
          "aspects": {
            "type": "object",
            "additionalProperties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "description": {
            "type": "string"
          },
          "imageUrls": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "inventoryItemGroupKey": {
            "type": "string"
          },
          "subtitle": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "variantSKUs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "variesBy": {
            "$ref": "#/$defs/inventory__VariesBy"
          },
          "videoIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__VariesBy": {
        "type": "object",
        "properties": {
          "aspectsImageVariesBy": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "specifications": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Specification"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__Specification": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
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
      "inventory__BulkMigrateListingResponse": {
        "type": "object",
        "properties": {
          "responses": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__MigrateListingResponse"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__MigrateListingResponse": {
        "type": "object",
        "properties": {
          "errors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          },
          "inventoryItemGroupKey": {
            "type": "string"
          },
          "inventoryItems": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__InventoryItemListing"
            }
          },
          "listingId": {
            "type": "string"
          },
          "marketplaceId": {
            "type": "string"
          },
          "statusCode": {
            "type": "integer"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__InventoryItemListing": {
        "type": "object",
        "properties": {
          "offerId": {
            "type": "string"
          },
          "sku": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__LocationMapping": {
        "type": "object",
        "properties": {
          "locations": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__LocationAvailabilityDetails"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__LocationAvailabilityDetails": {
        "type": "object",
        "properties": {
          "merchantLocationKey": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__BulkOfferResponse": {
        "type": "object",
        "properties": {
          "responses": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__OfferSkuResponse"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__OfferSkuResponse": {
        "type": "object",
        "properties": {
          "errors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          },
          "format": {
            "type": "string"
          },
          "marketplaceId": {
            "type": "string"
          },
          "offerId": {
            "type": "string"
          },
          "sku": {
            "type": "string"
          },
          "statusCode": {
            "type": "integer"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__BulkPublishResponse": {
        "type": "object",
        "properties": {
          "responses": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__OfferResponseWithListingId"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__OfferResponseWithListingId": {
        "type": "object",
        "properties": {
          "errors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          },
          "listingId": {
            "type": "string"
          },
          "offerId": {
            "type": "string"
          },
          "statusCode": {
            "type": "integer"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__Offers": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          },
          "limit": {
            "type": "integer"
          },
          "next": {
            "type": "string"
          },
          "offers": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__EbayOfferDetailsWithAll"
            }
          },
          "prev": {
            "type": "string"
          },
          "size": {
            "type": "integer"
          },
          "total": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "inventory__EbayOfferDetailsWithAll": {
        "type": "object",
        "properties": {
          "availableQuantity": {
            "type": "integer"
          },
          "categoryId": {
            "type": "string"
          },
          "charity": {
            "$ref": "#/$defs/inventory__Charity"
          },
          "extendedProducerResponsibility": {
            "$ref": "#/$defs/inventory__ExtendedProducerResponsibility"
          },
          "format": {
            "type": "string"
          },
          "hideBuyerDetails": {
            "type": "boolean"
          },
          "includeCatalogProductDetails": {
            "type": "boolean"
          },
          "listing": {
            "$ref": "#/$defs/inventory__ListingDetails"
          },
          "listingDescription": {
            "type": "string"
          },
          "listingDuration": {
            "type": "string"
          },
          "listingPolicies": {
            "$ref": "#/$defs/inventory__ListingPolicies"
          },
          "listingStartDate": {
            "type": "string"
          },
          "lotSize": {
            "type": "integer"
          },
          "marketplaceId": {
            "type": "string"
          },
          "merchantLocationKey": {
            "type": "string"
          },
          "offerId": {
            "type": "string"
          },
          "pricingSummary": {
            "$ref": "#/$defs/inventory__PricingSummary"
          },
          "quantityLimitPerBuyer": {
            "type": "integer"
          },
          "regulatory": {
            "$ref": "#/$defs/inventory__Regulatory"
          },
          "secondaryCategoryId": {
            "type": "string"
          },
          "sku": {
            "type": "string"
          },
          "status": {
            "type": "string"
          },
          "storeCategoryNames": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "tax": {
            "$ref": "#/$defs/inventory__Tax"
          }
        },
        "additionalProperties": true
      },
      "inventory__Charity": {
        "type": "object",
        "properties": {
          "charityId": {
            "type": "string"
          },
          "donationPercentage": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__ExtendedProducerResponsibility": {
        "type": "object",
        "properties": {
          "ecoParticipationFee": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "producerProductId": {
            "type": "string"
          },
          "productDocumentationId": {
            "type": "string"
          },
          "productPackageId": {
            "type": "string"
          },
          "shipmentPackageId": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__Amount": {
        "type": "object",
        "properties": {
          "currency": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__ListingDetails": {
        "type": "object",
        "properties": {
          "listingId": {
            "type": "string"
          },
          "listingOnHold": {
            "type": "boolean"
          },
          "listingStatus": {
            "type": "string"
          },
          "soldQuantity": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "inventory__ListingPolicies": {
        "type": "object",
        "properties": {
          "bestOfferTerms": {
            "$ref": "#/$defs/inventory__BestOffer"
          },
          "eBayPlusIfEligible": {
            "type": "boolean"
          },
          "fulfillmentPolicyId": {
            "type": "string"
          },
          "paymentPolicyId": {
            "type": "string"
          },
          "productCompliancePolicyIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "regionalProductCompliancePolicies": {
            "$ref": "#/$defs/inventory__RegionalProductCompliancePolicies"
          },
          "regionalTakeBackPolicies": {
            "$ref": "#/$defs/inventory__RegionalTakeBackPolicies"
          },
          "returnPolicyId": {
            "type": "string"
          },
          "shippingCostOverrides": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__ShippingCostOverride"
            }
          },
          "takeBackPolicyId": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__BestOffer": {
        "type": "object",
        "properties": {
          "autoAcceptPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "autoDeclinePrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "bestOfferEnabled": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "inventory__RegionalProductCompliancePolicies": {
        "type": "object",
        "properties": {
          "countryPolicies": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__CountryPolicy"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__CountryPolicy": {
        "type": "object",
        "properties": {
          "country": {
            "type": "string"
          },
          "policyIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__RegionalTakeBackPolicies": {
        "type": "object",
        "properties": {
          "countryPolicies": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__CountryPolicy"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__ShippingCostOverride": {
        "type": "object",
        "properties": {
          "additionalShippingCost": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "priority": {
            "type": "integer"
          },
          "shippingCost": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "shippingServiceType": {
            "type": "string"
          },
          "surcharge": {
            "$ref": "#/$defs/inventory__Amount"
          }
        },
        "additionalProperties": true
      },
      "inventory__PricingSummary": {
        "type": "object",
        "properties": {
          "auctionReservePrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "auctionStartPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "minimumAdvertisedPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "originallySoldForRetailPriceOn": {
            "type": "string"
          },
          "originalRetailPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "price": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "pricingVisibility": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__Regulatory": {
        "type": "object",
        "properties": {
          "documents": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Document"
            }
          },
          "energyEfficiencyLabel": {
            "$ref": "#/$defs/inventory__EnergyEfficiencyLabel"
          },
          "hazmat": {
            "$ref": "#/$defs/inventory__Hazmat"
          },
          "manufacturer": {
            "$ref": "#/$defs/inventory__Manufacturer"
          },
          "productSafety": {
            "$ref": "#/$defs/inventory__ProductSafety"
          },
          "repairScore": {
            "type": "number"
          },
          "responsiblePersons": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__ResponsiblePerson"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__Document": {
        "type": "object",
        "properties": {
          "documentId": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__EnergyEfficiencyLabel": {
        "type": "object",
        "properties": {
          "imageDescription": {
            "type": "string"
          },
          "imageURL": {
            "type": "string"
          },
          "productInformationSheet": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__Hazmat": {
        "type": "object",
        "properties": {
          "component": {
            "type": "string"
          },
          "pictograms": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "signalWord": {
            "type": "string"
          },
          "statements": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__Manufacturer": {
        "type": "object",
        "properties": {
          "addressLine1": {
            "type": "string"
          },
          "addressLine2": {
            "type": "string"
          },
          "city": {
            "type": "string"
          },
          "companyName": {
            "type": "string"
          },
          "contactUrl": {
            "type": "string"
          },
          "country": {
            "type": "string"
          },
          "email": {
            "type": "string"
          },
          "phone": {
            "type": "string"
          },
          "postalCode": {
            "type": "string"
          },
          "stateOrProvince": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__ProductSafety": {
        "type": "object",
        "properties": {
          "component": {
            "type": "string"
          },
          "pictograms": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "statements": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__ResponsiblePerson": {
        "type": "object",
        "properties": {
          "addressLine1": {
            "type": "string"
          },
          "addressLine2": {
            "type": "string"
          },
          "city": {
            "type": "string"
          },
          "companyName": {
            "type": "string"
          },
          "contactUrl": {
            "type": "string"
          },
          "country": {
            "type": "string"
          },
          "email": {
            "type": "string"
          },
          "phone": {
            "type": "string"
          },
          "postalCode": {
            "type": "string"
          },
          "stateOrProvince": {
            "type": "string"
          },
          "types": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__Tax": {
        "type": "object",
        "properties": {
          "applyTax": {
            "type": "boolean"
          },
          "thirdPartyTaxCategory": {
            "type": "string"
          },
          "vatPercentage": {
            "type": "number"
          }
        },
        "additionalProperties": true
      },
      "inventory__OfferResponse": {
        "type": "object",
        "properties": {
          "offerId": {
            "type": "string"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__FeesSummaryResponse": {
        "type": "object",
        "properties": {
          "feeSummaries": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__FeeSummary"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__FeeSummary": {
        "type": "object",
        "properties": {
          "fees": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Fee"
            }
          },
          "marketplaceId": {
            "type": "string"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__Fee": {
        "type": "object",
        "properties": {
          "amount": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "feeType": {
            "type": "string"
          },
          "promotionalDiscount": {
            "$ref": "#/$defs/inventory__Amount"
          }
        },
        "additionalProperties": true
      },
      "inventory__PublishResponse": {
        "type": "object",
        "properties": {
          "listingId": {
            "type": "string"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__WithdrawResponse": {
        "type": "object",
        "properties": {
          "listingId": {
            "type": "string"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__InventoryLocationResponse": {
        "type": "object",
        "properties": {
          "location": {
            "$ref": "#/$defs/inventory__Location"
          },
          "locationAdditionalInformation": {
            "type": "string"
          },
          "locationInstructions": {
            "type": "string"
          },
          "locationTypes": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "locationWebUrl": {
            "type": "string"
          },
          "merchantLocationKey": {
            "type": "string"
          },
          "merchantLocationStatus": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "operatingHours": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__OperatingHours"
            }
          },
          "phone": {
            "type": "string"
          },
          "specialHours": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__SpecialHours"
            }
          },
          "timeZoneId": {
            "type": "string"
          },
          "fulfillmentCenterSpecifications": {
            "$ref": "#/$defs/inventory__FulfillmentCenterSpecifications"
          }
        },
        "additionalProperties": true
      },
      "inventory__Location": {
        "type": "object",
        "properties": {
          "address": {
            "$ref": "#/$defs/inventory__Address"
          },
          "geoCoordinates": {
            "$ref": "#/$defs/inventory__GeoCoordinates"
          },
          "locationId": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__Address": {
        "type": "object",
        "properties": {
          "addressLine1": {
            "type": "string"
          },
          "addressLine2": {
            "type": "string"
          },
          "city": {
            "type": "string"
          },
          "country": {
            "type": "string"
          },
          "county": {
            "type": "string"
          },
          "postalCode": {
            "type": "string"
          },
          "stateOrProvince": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__GeoCoordinates": {
        "type": "object",
        "properties": {
          "latitude": {
            "type": "number"
          },
          "longitude": {
            "type": "number"
          }
        },
        "additionalProperties": true
      },
      "inventory__OperatingHours": {
        "type": "object",
        "properties": {
          "dayOfWeekEnum": {
            "type": "string"
          },
          "intervals": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Interval"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__Interval": {
        "type": "object",
        "properties": {
          "close": {
            "type": "string"
          },
          "open": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__SpecialHours": {
        "type": "object",
        "properties": {
          "date": {
            "type": "string"
          },
          "intervals": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Interval"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__FulfillmentCenterSpecifications": {
        "type": "object",
        "properties": {
          "sameDayShippingCutOffTimes": {
            "$ref": "#/$defs/inventory__SameDayShippingCutOffTimes"
          }
        },
        "additionalProperties": true
      },
      "inventory__SameDayShippingCutOffTimes": {
        "type": "object",
        "properties": {
          "overrides": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__Overrides"
            }
          },
          "weeklySchedule": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__WeeklySchedule"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__Overrides": {
        "type": "object",
        "properties": {
          "cutOffTime": {
            "type": "string"
          },
          "endDate": {
            "type": "string"
          },
          "startDate": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "inventory__WeeklySchedule": {
        "type": "object",
        "properties": {
          "cutOffTime": {
            "type": "string"
          },
          "dayOfWeekEnum": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "inventory__LocationResponse": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          },
          "limit": {
            "type": "integer"
          },
          "next": {
            "type": "string"
          },
          "offset": {
            "type": "integer"
          },
          "prev": {
            "type": "string"
          },
          "total": {
            "type": "integer"
          },
          "locations": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/inventory__InventoryLocationResponse"
            }
          }
        },
        "additionalProperties": true
      },
      "fulfillment__Order": {
        "type": "object",
        "properties": {
          "buyer": {
            "$ref": "#/$defs/fulfillment__Buyer"
          },
          "buyerCheckoutNotes": {
            "type": "string"
          },
          "cancelStatus": {
            "$ref": "#/$defs/fulfillment__CancelStatus"
          },
          "creationDate": {
            "type": "string"
          },
          "ebayCollectAndRemitTax": {
            "type": "boolean"
          },
          "fulfillmentHrefs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "fulfillmentStartInstructions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__FulfillmentStartInstruction"
            }
          },
          "lastModifiedDate": {
            "type": "string"
          },
          "lineItems": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__LineItem"
            }
          },
          "orderFulfillmentStatus": {
            "type": "string"
          },
          "orderId": {
            "type": "string"
          },
          "orderPaymentStatus": {
            "type": "string"
          },
          "paymentSummary": {
            "$ref": "#/$defs/fulfillment__PaymentSummary"
          },
          "pricingSummary": {
            "$ref": "#/$defs/fulfillment__PricingSummary"
          },
          "program": {
            "$ref": "#/$defs/fulfillment__Program"
          },
          "salesRecordReference": {
            "type": "string"
          },
          "sellerId": {
            "type": "string"
          },
          "totalFeeBasisAmount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "totalMarketplaceFee": {
            "$ref": "#/$defs/fulfillment__Amount"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__Buyer": {
        "type": "object",
        "properties": {
          "buyerRegistrationAddress": {
            "$ref": "#/$defs/fulfillment__ExtendedContact"
          },
          "taxAddress": {
            "$ref": "#/$defs/fulfillment__TaxAddress"
          },
          "taxIdentifier": {
            "$ref": "#/$defs/fulfillment__TaxIdentifier"
          },
          "username": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__ExtendedContact": {
        "type": "object",
        "properties": {
          "companyName": {
            "type": "string"
          },
          "contactAddress": {
            "$ref": "#/$defs/fulfillment__Address"
          },
          "email": {
            "type": "string"
          },
          "fullName": {
            "type": "string"
          },
          "primaryPhone": {
            "$ref": "#/$defs/fulfillment__PhoneNumber"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__Address": {
        "type": "object",
        "properties": {
          "addressLine1": {
            "type": "string"
          },
          "addressLine2": {
            "type": "string"
          },
          "city": {
            "type": "string"
          },
          "countryCode": {
            "type": "string"
          },
          "county": {
            "type": "string"
          },
          "postalCode": {
            "type": "string"
          },
          "stateOrProvince": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__PhoneNumber": {
        "type": "object",
        "properties": {
          "phoneNumber": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__TaxAddress": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string"
          },
          "countryCode": {
            "type": "string"
          },
          "postalCode": {
            "type": "string"
          },
          "stateOrProvince": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__TaxIdentifier": {
        "type": "object",
        "properties": {
          "taxpayerId": {
            "type": "string"
          },
          "taxIdentifierType": {
            "type": "string"
          },
          "issuingCountry": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__CancelStatus": {
        "type": "object",
        "properties": {
          "cancelledDate": {
            "type": "string"
          },
          "cancelRequests": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__CancelRequest"
            }
          },
          "cancelState": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__CancelRequest": {
        "type": "object",
        "properties": {
          "cancelCompletedDate": {
            "type": "string"
          },
          "cancelInitiator": {
            "type": "string"
          },
          "cancelReason": {
            "type": "string"
          },
          "cancelRequestedDate": {
            "type": "string"
          },
          "cancelRequestId": {
            "type": "string"
          },
          "cancelRequestState": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__FulfillmentStartInstruction": {
        "type": "object",
        "properties": {
          "appointment": {
            "$ref": "#/$defs/fulfillment__AppointmentDetails"
          },
          "ebaySupportedFulfillment": {
            "type": "boolean"
          },
          "finalDestinationAddress": {
            "$ref": "#/$defs/fulfillment__Address"
          },
          "fulfillmentInstructionsType": {
            "type": "string"
          },
          "maxEstimatedDeliveryDate": {
            "type": "string"
          },
          "minEstimatedDeliveryDate": {
            "type": "string"
          },
          "pickupStep": {
            "$ref": "#/$defs/fulfillment__PickupStep"
          },
          "shippingStep": {
            "$ref": "#/$defs/fulfillment__ShippingStep"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__AppointmentDetails": {
        "type": "object",
        "properties": {
          "appointmentEndTime": {
            "type": "string"
          },
          "appointmentStartTime": {
            "type": "string"
          },
          "appointmentStatus": {
            "type": "string"
          },
          "appointmentType": {
            "type": "string"
          },
          "appointmentWindow": {
            "type": "string"
          },
          "serviceProviderAppointmentDate": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__PickupStep": {
        "type": "object",
        "properties": {
          "merchantLocationKey": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__ShippingStep": {
        "type": "object",
        "properties": {
          "shippingCarrierCode": {
            "type": "string"
          },
          "shippingServiceCode": {
            "type": "string"
          },
          "shipTo": {
            "$ref": "#/$defs/fulfillment__ExtendedContact"
          },
          "shipToReferenceId": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__LineItem": {
        "type": "object",
        "properties": {
          "appliedPromotions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__AppliedPromotion"
            }
          },
          "compatibilityProperties": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__Property"
            }
          },
          "deliveryCost": {
            "$ref": "#/$defs/fulfillment__DeliveryCost"
          },
          "discountedLineItemCost": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "ebayCollectAndRemitTaxes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__EbayCollectAndRemitTax"
            }
          },
          "ebayCollectedCharges": {
            "$ref": "#/$defs/fulfillment__EbayCollectedCharges"
          },
          "giftDetails": {
            "$ref": "#/$defs/fulfillment__GiftDetails"
          },
          "itemLocation": {
            "$ref": "#/$defs/fulfillment__ItemLocation"
          },
          "legacyItemId": {
            "type": "string"
          },
          "legacyVariationId": {
            "type": "string"
          },
          "lineItemCost": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "lineItemFulfillmentInstructions": {
            "$ref": "#/$defs/fulfillment__LineItemFulfillmentInstructions"
          },
          "lineItemFulfillmentStatus": {
            "type": "string"
          },
          "lineItemId": {
            "type": "string"
          },
          "linkedOrderLineItems": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__LinkedOrderLineItem"
            }
          },
          "listingMarketplaceId": {
            "type": "string"
          },
          "properties": {
            "$ref": "#/$defs/fulfillment__LineItemProperties"
          },
          "purchaseMarketplaceId": {
            "type": "string"
          },
          "quantity": {
            "type": "integer"
          },
          "refunds": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__LineItemRefund"
            }
          },
          "sku": {
            "type": "string"
          },
          "soldFormat": {
            "type": "string"
          },
          "taxes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__Tax"
            }
          },
          "title": {
            "type": "string"
          },
          "total": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "variationAspects": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__NameValuePair"
            }
          }
        },
        "additionalProperties": true
      },
      "fulfillment__AppliedPromotion": {
        "type": "object",
        "properties": {
          "description": {
            "type": "string"
          },
          "discountAmount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "promotionId": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__Amount": {
        "type": "object",
        "properties": {
          "convertedFromCurrency": {
            "type": "string"
          },
          "convertedFromValue": {
            "type": "string"
          },
          "currency": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__Property": {
        "type": "object",
        "properties": {
          "propertyDisplayName": {
            "type": "string"
          },
          "propertyName": {
            "type": "string"
          },
          "propertyValue": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__DeliveryCost": {
        "type": "object",
        "properties": {
          "discountAmount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "handlingCost": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "importCharges": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "shippingCost": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "shippingIntermediationFee": {
            "$ref": "#/$defs/fulfillment__Amount"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__EbayCollectAndRemitTax": {
        "type": "object",
        "properties": {
          "amount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "ebayReference": {
            "$ref": "#/$defs/fulfillment__EbayTaxReference"
          },
          "taxType": {
            "type": "string"
          },
          "collectionMethod": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__EbayTaxReference": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__EbayCollectedCharges": {
        "type": "object",
        "properties": {
          "ebayShipping": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "charges": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__Charge"
            }
          }
        },
        "additionalProperties": true
      },
      "fulfillment__Charge": {
        "type": "object",
        "properties": {
          "amount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "chargeType": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__GiftDetails": {
        "type": "object",
        "properties": {
          "message": {
            "type": "string"
          },
          "recipientEmail": {
            "type": "string"
          },
          "senderName": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__ItemLocation": {
        "type": "object",
        "properties": {
          "countryCode": {
            "type": "string"
          },
          "location": {
            "type": "string"
          },
          "postalCode": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__LineItemFulfillmentInstructions": {
        "type": "object",
        "properties": {
          "guaranteedDelivery": {
            "type": "boolean"
          },
          "maxEstimatedDeliveryDate": {
            "type": "string"
          },
          "minEstimatedDeliveryDate": {
            "type": "string"
          },
          "shipByDate": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__LinkedOrderLineItem": {
        "type": "object",
        "properties": {
          "lineItemAspects": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__NameValuePair"
            }
          },
          "lineItemId": {
            "type": "string"
          },
          "maxEstimatedDeliveryDate": {
            "type": "string"
          },
          "minEstimatedDeliveryDate": {
            "type": "string"
          },
          "orderId": {
            "type": "string"
          },
          "sellerId": {
            "type": "string"
          },
          "shipments": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__TrackingInfo"
            }
          },
          "title": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__NameValuePair": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__TrackingInfo": {
        "type": "object",
        "properties": {
          "shipmentTrackingNumber": {
            "type": "string"
          },
          "shippingCarrierCode": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__LineItemProperties": {
        "type": "object",
        "properties": {
          "buyerProtection": {
            "type": "boolean"
          },
          "fromBestOffer": {
            "type": "boolean"
          },
          "soldViaAdCampaign": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__LineItemRefund": {
        "type": "object",
        "properties": {
          "amount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "refundDate": {
            "type": "string"
          },
          "refundId": {
            "type": "string"
          },
          "refundReferenceId": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__Tax": {
        "type": "object",
        "properties": {
          "amount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "taxType": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__PaymentSummary": {
        "type": "object",
        "properties": {
          "payments": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__Payment"
            }
          },
          "refunds": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__OrderRefund"
            }
          },
          "totalDueSeller": {
            "$ref": "#/$defs/fulfillment__Amount"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__Payment": {
        "type": "object",
        "properties": {
          "amount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "paymentDate": {
            "type": "string"
          },
          "paymentHolds": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__PaymentHold"
            }
          },
          "paymentMethod": {
            "type": "string"
          },
          "paymentReferenceId": {
            "type": "string"
          },
          "paymentStatus": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__PaymentHold": {
        "type": "object",
        "properties": {
          "expectedReleaseDate": {
            "type": "string"
          },
          "holdAmount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "holdReason": {
            "type": "string"
          },
          "holdState": {
            "type": "string"
          },
          "releaseDate": {
            "type": "string"
          },
          "sellerActionsToRelease": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__SellerActionsToRelease"
            }
          }
        },
        "additionalProperties": true
      },
      "fulfillment__SellerActionsToRelease": {
        "type": "object",
        "properties": {
          "sellerActionToRelease": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__OrderRefund": {
        "type": "object",
        "properties": {
          "amount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "refundDate": {
            "type": "string"
          },
          "refundId": {
            "type": "string"
          },
          "refundReferenceId": {
            "type": "string"
          },
          "refundStatus": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__PricingSummary": {
        "type": "object",
        "properties": {
          "adjustment": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "deliveryCost": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "deliveryDiscount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "fee": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "priceDiscount": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "priceSubtotal": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "tax": {
            "$ref": "#/$defs/fulfillment__Amount"
          },
          "total": {
            "$ref": "#/$defs/fulfillment__Amount"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__Program": {
        "type": "object",
        "properties": {
          "authenticityVerification": {
            "$ref": "#/$defs/fulfillment__PostSaleAuthenticationProgram"
          },
          "ebayShipping": {
            "$ref": "#/$defs/fulfillment__EbayShipping"
          },
          "ebayVault": {
            "$ref": "#/$defs/fulfillment__EbayVaultProgram"
          },
          "ebayInternationalShipping": {
            "$ref": "#/$defs/fulfillment__EbayInternationalShipping"
          },
          "fulfillmentProgram": {
            "$ref": "#/$defs/fulfillment__EbayFulfillmentProgram"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__PostSaleAuthenticationProgram": {
        "type": "object",
        "properties": {
          "outcomeReason": {
            "type": "string"
          },
          "status": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__EbayShipping": {
        "type": "object",
        "properties": {
          "shippingLabelProvidedBy": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__EbayVaultProgram": {
        "type": "object",
        "properties": {
          "fulfillmentType": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__EbayInternationalShipping": {
        "type": "object",
        "properties": {
          "returnsManagedBy": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__EbayFulfillmentProgram": {
        "type": "object",
        "properties": {
          "fulfilledBy": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__OrderSearchPagedCollection": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          },
          "limit": {
            "type": "integer"
          },
          "next": {
            "type": "string"
          },
          "offset": {
            "type": "integer"
          },
          "orders": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__Order"
            }
          },
          "prev": {
            "type": "string"
          },
          "total": {
            "type": "integer"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "fulfillment__Error": {
        "type": "object",
        "properties": {
          "category": {
            "type": "string"
          },
          "domain": {
            "type": "string"
          },
          "errorId": {
            "type": "integer"
          },
          "inputRefIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "longMessage": {
            "type": "string"
          },
          "message": {
            "type": "string"
          },
          "outputRefIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "parameters": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__ErrorParameter"
            }
          },
          "subdomain": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__ErrorParameter": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__ShippingFulfillmentPagedCollection": {
        "type": "object",
        "properties": {
          "fulfillments": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__ShippingFulfillment"
            }
          },
          "total": {
            "type": "integer"
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "fulfillment__ShippingFulfillment": {
        "type": "object",
        "properties": {
          "fulfillmentId": {
            "type": "string"
          },
          "lineItems": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/fulfillment__LineItemReference"
            }
          },
          "shipmentTrackingNumber": {
            "type": "string"
          },
          "shippedDate": {
            "type": "string"
          },
          "shippingCarrierCode": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "fulfillment__LineItemReference": {
        "type": "object",
        "properties": {
          "lineItemId": {
            "type": "string"
          },
          "quantity": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "catalog__Product": {
        "type": "object",
        "properties": {
          "additionalImages": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/catalog__Image"
            }
          },
          "aspects": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/catalog__Aspect"
            }
          },
          "brand": {
            "type": "string"
          },
          "compatibilityCount": {
            "type": "integer"
          },
          "description": {
            "type": "string"
          },
          "ean": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "epid": {
            "type": "string"
          },
          "gtin": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "image": {
            "$ref": "#/$defs/catalog__Image"
          },
          "isbn": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "mpn": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "otherApplicableCategoryIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "primaryCategoryId": {
            "type": "string"
          },
          "productWebUrl": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "upc": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "version": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "catalog__Image": {
        "type": "object",
        "properties": {
          "height": {
            "type": "integer"
          },
          "imageUrl": {
            "type": "string"
          },
          "width": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "catalog__Aspect": {
        "type": "object",
        "properties": {
          "localizedName": {
            "type": "string"
          },
          "localizedValues": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "catalog__ProductSearchResponse": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          },
          "limit": {
            "type": "integer"
          },
          "next": {
            "type": "string"
          },
          "offset": {
            "type": "integer"
          },
          "prev": {
            "type": "string"
          },
          "productSummaries": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/catalog__ProductSummary"
            }
          },
          "refinement": {
            "$ref": "#/$defs/catalog__Refinement"
          },
          "total": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "catalog__ProductSummary": {
        "type": "object",
        "properties": {
          "additionalImages": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/catalog__Image"
            }
          },
          "aspects": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/catalog__Aspect"
            }
          },
          "brand": {
            "type": "string"
          },
          "ean": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "epid": {
            "type": "string"
          },
          "gtin": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "image": {
            "$ref": "#/$defs/catalog__Image"
          },
          "isbn": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "mpn": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "productHref": {
            "type": "string"
          },
          "productWebUrl": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "upc": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "catalog__Refinement": {
        "type": "object",
        "properties": {
          "aspectDistributions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/catalog__AspectDistribution"
            }
          },
          "dominantCategoryId": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "catalog__AspectDistribution": {
        "type": "object",
        "properties": {
          "aspectValueDistributions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/catalog__AspectValueDistribution"
            }
          },
          "localizedAspectName": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "catalog__AspectValueDistribution": {
        "type": "object",
        "properties": {
          "localizedAspectValue": {
            "type": "string"
          },
          "matchCount": {
            "type": "integer"
          },
          "refinementHref": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "metadata__ItemConditionPolicyResponse": {
        "type": "object",
        "properties": {
          "itemConditionPolicies": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/metadata__ItemConditionPolicy"
            }
          },
          "warnings": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/metadata__Error"
            }
          }
        },
        "additionalProperties": true
      },
      "metadata__ItemConditionPolicy": {
        "type": "object",
        "properties": {
          "categoryId": {
            "type": "string"
          },
          "categoryTreeId": {
            "type": "string"
          },
          "itemConditionRequired": {
            "type": "boolean"
          },
          "itemConditions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/metadata__ItemCondition"
            }
          }
        },
        "additionalProperties": true
      },
      "metadata__ItemCondition": {
        "type": "object",
        "properties": {
          "conditionDescription": {
            "type": "string"
          },
          "conditionDescriptors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/metadata__ItemConditionDescriptor"
            }
          },
          "conditionHelpText": {
            "type": "string"
          },
          "conditionId": {
            "type": "string"
          },
          "usage": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "metadata__ItemConditionDescriptor": {
        "type": "object",
        "properties": {
          "conditionDescriptorConstraint": {
            "$ref": "#/$defs/metadata__ItemConditionDescriptorConstraint"
          },
          "conditionDescriptorHelpText": {
            "type": "string"
          },
          "conditionDescriptorId": {
            "type": "string"
          },
          "conditionDescriptorName": {
            "type": "string"
          },
          "conditionDescriptorValues": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/metadata__ItemConditionDescriptorValue"
            }
          }
        },
        "additionalProperties": true
      },
      "metadata__ItemConditionDescriptorConstraint": {
        "type": "object",
        "properties": {
          "applicableToConditionDescriptorIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "cardinality": {
            "type": "string"
          },
          "defaultConditionDescriptorValueId": {
            "type": "string"
          },
          "maxLength": {
            "type": "integer"
          },
          "mode": {
            "type": "string"
          },
          "usage": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "metadata__ItemConditionDescriptorValue": {
        "type": "object",
        "properties": {
          "conditionDescriptorValueAdditionalHelpText": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "conditionDescriptorValueConstraints": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/metadata__ItemConditionDescriptorValueConstraint"
            }
          },
          "conditionDescriptorValueHelpText": {
            "type": "string"
          },
          "conditionDescriptorValueId": {
            "type": "string"
          },
          "conditionDescriptorValueName": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "metadata__ItemConditionDescriptorValueConstraint": {
        "type": "object",
        "properties": {
          "applicableToConditionDescriptorId": {
            "type": "string"
          },
          "applicableToConditionDescriptorValueIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "metadata__Error": {
        "type": "object",
        "properties": {
          "category": {
            "type": "string"
          },
          "domain": {
            "type": "string"
          },
          "errorId": {
            "type": "integer"
          },
          "inputRefIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "longMessage": {
            "type": "string"
          },
          "message": {
            "type": "string"
          },
          "outputRefIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "parameters": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/metadata__ErrorParameter"
            }
          },
          "subdomain": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "metadata__ErrorParameter": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "negotiation__PagedEligibleItemCollection": {
        "type": "object",
        "properties": {
          "eligibleItems": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/negotiation__EligibleItem"
            }
          },
          "href": {
            "type": "string"
          },
          "limit": {
            "type": "integer"
          },
          "next": {
            "type": "string"
          },
          "offset": {
            "type": "integer"
          },
          "prev": {
            "type": "string"
          },
          "total": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "negotiation__EligibleItem": {
        "type": "object",
        "properties": {
          "listingId": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "negotiation__SendOfferToInterestedBuyersCollectionResponse": {
        "type": "object",
        "properties": {
          "offers": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/negotiation__Offer"
            }
          }
        },
        "additionalProperties": true
      },
      "negotiation__Offer": {
        "type": "object",
        "properties": {
          "allowCounterOffer": {
            "type": "boolean"
          },
          "buyer": {
            "$ref": "#/$defs/negotiation__User"
          },
          "creationDate": {
            "type": "string"
          },
          "initiatedBy": {
            "type": "string"
          },
          "lastModifiedDate": {
            "type": "string"
          },
          "message": {
            "type": "string"
          },
          "offerDuration": {
            "$ref": "#/$defs/negotiation__TimeDuration"
          },
          "offeredItems": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/negotiation__OfferedItem"
            }
          },
          "offerId": {
            "type": "string"
          },
          "offerStatus": {
            "type": "string"
          },
          "offerType": {
            "type": "string"
          },
          "revision": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "negotiation__User": {
        "type": "object",
        "properties": {
          "maskedUsername": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "negotiation__TimeDuration": {
        "type": "object",
        "properties": {
          "unit": {
            "type": "string"
          },
          "value": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "negotiation__OfferedItem": {
        "type": "object",
        "properties": {
          "discountPercentage": {
            "type": "string"
          },
          "listingId": {
            "type": "string"
          },
          "price": {
            "$ref": "#/$defs/negotiation__Amount"
          },
          "quantity": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "negotiation__Amount": {
        "type": "object",
        "properties": {
          "currency": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      }
    },
    "W": {
      "account__CustomPolicyCreateRequest": {
        "type": "object",
        "description": "This type is used by the request payload of the createCustomPolicy method to define a new custom policy for a specific marketplace.",
        "properties": {
          "description": {
            "type": "string",
            "description": "Contains the seller's policy and policy terms. Max length: 15,000",
            "maxLength": 262144
          },
          "label": {
            "type": "string",
            "description": "Customer-facing label shown on View Item pages for items to which the policy applies. This seller-defined string is displayed as a system-generated hyperlink pointing to the seller's policy information. Max length: 65",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "The seller-defined name for the custom policy. Names must be unique for policies assigned to the same seller and policy type. Note: This field is visible only to the seller. Max length: 65",
            "maxLength": 262144
          },
          "policyType": {
            "type": "string",
            "description": "Specifies the type of custom policy being created. Two Custom Policy types are supported: Product Compliance (PRODUCT_COMPLIANCE) Takeback (TAKE_BACK) For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__FulfillmentPolicyRequest": {
        "type": "object",
        "description": "This root container defines a seller's fulfillment policy for a specific marketplace and category group. This type is used when creating or updating a fulfillment business policy.",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "description": "This container is used to specify whether the fulfillment business policy applies to motor vehicle listings, or if it applies to non-motor vehicle listings.",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            },
            "maxItems": 25
          },
          "description": {
            "type": "string",
            "description": "A seller-defined description of the fulfillment policy. This description is only for the seller's use, and is not exposed on any eBay pages. Max length : 250",
            "maxLength": 262144
          },
          "freightShipping": {
            "type": "boolean",
            "description": "This field is included and set to true if freight shipping is available for the item. Freight shipping can be used for large items over 150 lbs. Default : false"
          },
          "globalShipping": {
            "type": "boolean",
            "description": "Note : This field is only applicable for the eBay United Kingdom marketplace ( EBAY_GB ). This field is included and set to true if the seller wants to use the Global Shipping Program for international shipments. See the Global Shipping Program help topic for more details and requirements on the Global Shipping Program. A seller can use a combination of the Global Shipping Program and other international shipping services. If set to false or if the field is omitted, the seller has to manually specifying individual international shipping services (if the seller ships internationally), as described in Setting up worldwide shipping . Sellers opt in or out of the Global Shipping Program through the Shipping preferences in My eBay. eBay International Shipping is an account level setting; no field needs to be set in a Fulfillment business policy to enable eBay International Shipping. If a US seller's account is opted in to eBay International Shipping, this shipping option will be enabled automatically for all listings where international shipping is available. A US seller who is opted in to eBay International Shipping can also specify individual international shipping service options for a Fulfillment business policy. Default : false"
          },
          "handlingTime": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "localPickup": {
            "type": "boolean",
            "description": "This field should be included and set to true if local pickup is one of the fulfillment options available to the buyer. It is possible for the seller to make local pickup and some shipping service options available to the buyer. With local pickup, the buyer and seller make arrangements for pickup time and location. Default : false"
          },
          "marketplaceId": {
            "type": "string",
            "description": "The ID of the eBay marketplace to which this fulfillment policy applies. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "A seller-defined name for this fulfillment policy. Names must be unique for policies assigned to the same marketplace. Max length : 64",
            "maxLength": 262144
          },
          "pickupDropOff": {
            "type": "boolean",
            "description": "This field should be included and set to true if the seller offers the \"Click and Collect\" feature for an item. To enable \"Click and Collect\" on a listing, a seller must be eligible for Click and Collect. Currently, Click and Collect is available to only large retail merchants selling in the eBay AU, UK, DE, FR, and IT marketplaces. In addition to setting this field to true , the merchant must also do the following to enable the \"Click and Collect\" option on a listing: Have inventory for the product at one or more physical stores tied to the merchant's account. Sellers can use the createInventoryLocation method in the Inventory API to associate physical stores to their account and they can then add inventory to specific store locations. Set an immediate payment requirement on the item. The immediate payment feature requires the seller to: Set the immediatePay flag in the payment policy to 'true'. Have a valid store location with a complete street address. When a merchant successfully lists an item with Click and Collect, prospective buyers within a reasonable distance from one of the merchant's stores (that has stock available) will see the \"Available for Click and Collect\" option on the listing, along with information on the closest store that has the item. Default : false"
          },
          "shippingOptions": {
            "type": "array",
            "description": "This array is used to provide detailed information on the domestic and international shipping options available for the policy. A separate ShippingOption object is required for domestic shipping service options and for international shipping service options (if the seller ships to international locations). The optionType field is used to indicate whether the ShippingOption object applies to domestic or international shipping, and the costType field is used to indicate whether flat-rate shipping or calculated shipping will be used. The rateTableId field can be used to associate a defined shipping rate table to the policy, and the packageHandlingCost container can be used to set a handling charge for the policy. A separate ShippingServices object will be used to specify cost and other details for every available domestic and international shipping service option.",
            "items": {
              "$ref": "#/$defs/account__ShippingOption"
            },
            "maxItems": 25
          },
          "shipToLocations": {
            "$ref": "#/$defs/account__RegionSet"
          }
        },
        "additionalProperties": false
      },
      "account__CategoryType": {
        "type": "object",
        "description": "The category type discerns whether the policy applies to motor vehicle listings, or to any other items except motor vehicle listings. Each business policy can be associated with either or both categories ('MOTORS_VEHICLES' and 'ALL_EXCLUDING_MOTORS_VEHICLES'); however, return business policies are not applicable for motor vehicle listings.",
        "properties": {
          "default": {
            "type": "boolean",
            "description": "Note: This field has been deprecated and is no longer used. Do not include this field in any create or update method. This field may be returned within the payload of a get method, but it can be ignored."
          },
          "name": {
            "type": "string",
            "description": "The category type to which the policy applies (motor vehicles or non-motor vehicles). Note: The MOTORS_VEHICLES category type is not valid for return policies. eBay flows do not support the return of motor vehicles. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__TimeDuration": {
        "type": "object",
        "description": "A type used to specify a period of time using a specified time-measurement unit. Payment, return, and fulfillment business policies all use this type to specify time windows. Whenever a container that uses this type is used in a request, both of these fields are required. Similarly, whenever a container that uses this type is returned in a response, both of these fields are always returned.",
        "properties": {
          "unit": {
            "type": "string",
            "description": "These enum values represent the time measurement unit, such as DAY . A span of time is defined when you apply the value specified in the value field to the value specified for unit . See TimeDurationUnitEnum for a complete list of possible time-measurement units. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "value": {
            "type": "integer",
            "description": "An integer that represents an amount of time, as measured by the time-measurement unit specified in the unit field.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "account__ShippingOption": {
        "type": "object",
        "description": "This type is used by the shippingOptions array, which is used to provide detailed information on the domestic and international shipping options available for the policy. A separate ShippingOption object covers domestic shipping service options and international shipping service options (if the seller ships to international locations).",
        "properties": {
          "costType": {
            "type": "string",
            "description": "This field defines whether the shipping cost model is FLAT_RATE (the same rate for all buyers, or buyers within a region if shipping rate tables are used) or CALCULATED (the shipping rate varies by the ship-to location and size and weight of the package). This field is conditionally required if any shipping service options are specified (domestic and/or international). For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "insuranceFee": {
            "$ref": "#/$defs/account__Amount"
          },
          "insuranceOffered": {
            "type": "boolean",
            "description": "This field has been deprecated. Shipping insurance is offered only via a shipping carrier's shipping services and is no longer available via eBay shipping policies."
          },
          "optionType": {
            "type": "string",
            "description": "This field is used to indicate if the corresponding shipping service options (under shippingServices array) are domestic or international shipping service options. This field is conditionally required if any shipping service options are specified (domestic and/or international). For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "packageHandlingCost": {
            "$ref": "#/$defs/account__Amount"
          },
          "rateTableId": {
            "type": "string",
            "description": "This field is used if the seller wants to associate a domestic or international shipping rate table to the fulfillment business policy. The getRateTables method can be used to retrieve shipping rate table IDs. With domestic and international shipping rate tables, the seller can set different shipping costs based on shipping regions and shipping speed/level of service (one-day, expedited, standard, economy). There are also options to add additional per-weight and handling charges. Sellers need to be careful that shipping rate tables match the corresponding shipping service options. In other words, a domestic shipping rate table must not be specified in the same container where international shipping service options are being specified, and vice versa, and the shipping speed/level of service of the provided shipping service options should match the shipping speed/level of service options that are defined in the shipping rate tables. For example, if the corresponding shipping rate table defines costs for one-day shipping services, there should be at least one one-day shipping service option specified under the shippingServices array. This field is returned if set.",
            "maxLength": 262144
          },
          "shippingDiscountProfileId": {
            "type": "string",
            "description": "This field is the unique identifier of a seller's domestic or international shipping discount profile. If a buyer satisfies the requirements of the discount rule, this buyer will receive a shipping discount for the order. The seller can create and manage shipping discount profiles using (Get/Set) ShippingDiscountProfiles calls in the Trading API or through the Shipping Preferences in My eBay .",
            "maxLength": 262144
          },
          "shippingPromotionOffered": {
            "type": "boolean",
            "description": "This boolean indicates whether or not the seller has set up a promotional shipping discount that will be available to buyers who satisfy the requirements of the shipping discount rule. The seller can create and manage shipping promotional discounts using (Get/Set) ShippingDiscountProfiles calls in the Trading API or through the Shipping Preferences in My eBay ."
          },
          "shippingServices": {
            "type": "array",
            "description": "This array consists of the domestic or international shipping services options that are defined for the policy. The shipping service options defined under this array should match what is set in the corresponding shippingOptions.optionType field (which controls whether domestic or international shipping service options are being defined). If a shipping rate table is being used, the specified shipping service options should also match the shipping rate table settings (domestic or international, shipping speed/level of service, etc.) Sellers can specify up to four domestic shipping services and up to five international shipping service options by using separate shippingService containers for each. If the seller is using the Global Shipping Program as an international option, only a total of four international shipping service options (including GSP) can be offered. See How to set up shipping carrier and shipping service values . To use the eBay standard envelope service (eSE), see Using eBay standard envelope (eSE) service . This array is conditionally required if the seller is offering one or more domestic and/or international shipping service options.",
            "items": {
              "$ref": "#/$defs/account__ShippingService"
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "account__Amount": {
        "type": "object",
        "description": "A complex type that describes the value of a monetary amount as represented by a global currency. When passing in an amount in a request payload, both currency and value fields are required, and both fields are also always returned for an amount in a response field.",
        "properties": {
          "currency": {
            "type": "string",
            "description": "The base currency applied to the value field to establish a monetary amount. The currency is represented as a 3-letter ISO 4217 currency code. For example, the code for the Canadian Dollar is CAD . Default: The default currency of the eBay marketplace that hosts the listing. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "value": {
            "type": "string",
            "description": "The monetary amount in the specified currency .",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__ShippingService": {
        "type": "object",
        "description": "This type is used by the shippingServices array, an array that provides details about every domestic and international shipping service option that is defined for the policy.",
        "properties": {
          "additionalShippingCost": {
            "$ref": "#/$defs/account__Amount"
          },
          "buyerResponsibleForPickup": {
            "type": "boolean",
            "description": "This field should be included and set to true for a motor vehicle listing if it will be the buyer's responsibility to pick up the purchased motor vehicle after full payment is made. This field is only applicable to motor vehicle listings. In the majority of motor vehicle listings, the seller does make the buyer responsible for pickup or shipment of the vehicle. This field is returned if set. Default : false"
          },
          "buyerResponsibleForShipping": {
            "type": "boolean",
            "description": "This field should be included and set to true for a motor vehicle listing if it will be the buyer's responsibility to arrange for shipment of a motor vehicle. This field is only applicable to motor vehicle listings. In the majority of motor vehicle listings, the seller does make the buyer responsible for pickup or shipment of the vehicle. This field is returned if set. Default : false"
          },
          "freeShipping": {
            "type": "boolean",
            "description": "This field is included and set to true if the seller offers a free domestic shipping option to the buyer. This field can only be included and set to true for the first domestic shipping service option specified in the shippingServices array (it is ignored if set for subsequent shipping services or for any international shipping service option). The first specified shipping service option has a sortOrder value of 1 or if the sortOrderId field is not used, it is the shipping service option that's specified first in the shippingServices array. This container is returned if set."
          },
          "shippingCarrierCode": {
            "type": "string",
            "description": "This field sets/indicates the shipping carrier, such as USPS , FedEx , or UPS . Although this field uses the string type, the seller must pass in a pre-defined enumeration value here. For a full list of shipping carrier enum values for a specified eBay marketplace, the GeteBayDetails call of the Trading API can be used, and the DetailName field's value should be set to ShippingCarrierDetails . The enum values for each shipping carriers can be found in each ShippingCarrierDetails.ShippingCarrier field in the response payload. This field is actually optional, as the shipping carrier is also tied into the shippingServiceCode enum value, and that field is required for every specified shipping service option. This field is returned if set.",
            "maxLength": 262144
          },
          "shippingCost": {
            "$ref": "#/$defs/account__Amount"
          },
          "shippingServiceCode": {
            "type": "string",
            "description": "This field sets/indicates the domestic or international shipping service option, such as USPSPriority , FedEx2Day , or UPS3rdDay . Although this field uses the string type, the seller must pass in a pre-defined enumeration value here. For a full list of shipping service option enum values for a specified eBay marketplace, the GeteBayDetails call of the Trading API can be used, and the DetailName field's value should be set to ShippingServiceDetails . The enum values for each shipping service option can be found in each ShippingServiceDetails.ShippingService field in the response payload. The seller must make sure that the shipping service option is still valid, which is indicated by a true value in the corresponding ValidForSellingFlow boolean field. International shipping service options are typically returned at the top of the response payload, and are indicated by an InternationalService boolean field that reads true . The InternationalService boolean field is not returned at all for domestic shipping service options. This field is required for every specified shipping service option.",
            "maxLength": 262144
          },
          "shipToLocations": {
            "$ref": "#/$defs/account__RegionSet"
          },
          "sortOrder": {
            "type": "integer",
            "description": "The integer value set in this field controls the order of the corresponding domestic or international shipping service option in the View Item and Checkout pages. If the sortOrder field is not supplied, the order of domestic and international shipping service options is determined by the order in which they are listed in the API call. Min : 1. Max : 4 (for domestic shipping service) or 5 (for international shipping service).",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "surcharge": {
            "$ref": "#/$defs/account__Amount"
          }
        },
        "additionalProperties": false
      },
      "account__RegionSet": {
        "type": "object",
        "description": "This type consists of the regionIncluded and regionExcluded arrays, which indicate the areas to where the seller does and doesn't ship.",
        "properties": {
          "regionExcluded": {
            "type": "array",
            "description": "An array of one or more regionName values that specify the areas to where a seller does not ship. A regionExcluded list should only be set in the top-level shipToLocations container and not within the shippingServices.shipToLocations container used to specify which shipping regions are serviced by each available shipping service option. Many sellers are willing to ship to many international locations, but they may want to exclude some world regions or some countries as places they are willing to ship to. This array will be returned as empty if no shipping regions are excluded with the fulfillment business policy. Note: The regionExcluded array is not applicable for motor vehicle business policies on the US, CA, or UK marketplaces. If this array is used in a createFulfillmentPolicy or updateFulfillmentPolicy request, it will be ignored.",
            "items": {
              "$ref": "#/$defs/account__Region"
            },
            "maxItems": 25
          },
          "regionIncluded": {
            "type": "array",
            "description": "An array of one or more regionName fields that specify the areas to where a seller ships. Each eBay marketplace supports its own set of allowable shipping locations. Note: The regionIncluded array is not applicable for motor vehicle business policies on the US, CA, or UK marketplaces. If this array is used in a createFulfillmentPolicy or updateFulfillmentPolicy request, it will be ignored.",
            "items": {
              "$ref": "#/$defs/account__Region"
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "account__Region": {
        "type": "object",
        "description": "This type is used to define specific shipping regions. There are four 'levels' of shipping regions, including large geographical regions (like 'Asia', 'Europe', or 'Middle East'), individual countries, US states or Canadian provinces, and special locations/domestic regions within a country (like 'Alaska/Hawaii' or 'PO Box').",
        "properties": {
          "regionName": {
            "type": "string",
            "description": "A string that indicates the name of a region, as defined by eBay. A \"region\" can be either a 'world region' (e.g., the \"Middle East\" or \"Southeast Asia\"), a country (represented with a two-letter country code), a state or province (represented with a two-letter code), or a special domestic region within a country. The GeteBayDetails call in the Trading API can be used to retrieve the world regions and special domestic regions within a specific country. To get these enumeration values, call GeteBayDetails with the DetailName value set to ExcludeShippingLocationDetails .",
            "maxLength": 262144
          },
          "regionType": {
            "type": "string",
            "description": "Reserved for future use. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__PaymentPolicyRequest": {
        "type": "object",
        "description": "This root container defines a seller's payment business policy for a specific marketplace and category group. This type is used when creating or updating a payment business policy.",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "description": "This container is used to specify whether the payment business policy applies to motor vehicle listings, or if it applies to non-motor vehicle listings.",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            },
            "maxItems": 25
          },
          "deposit": {
            "$ref": "#/$defs/account__Deposit"
          },
          "description": {
            "type": "string",
            "description": "A seller-defined description of the payment business policy. This description is only for the seller's use, and is not exposed on any eBay pages. Max length : 250",
            "maxLength": 262144
          },
          "fullPaymentDueIn": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "immediatePay": {
            "type": "boolean",
            "description": "This field should be included and set to true if the seller wants to require immediate payment from the buyer for: A fixed-price item An auction item where the buyer is using the 'Buy it Now' option A deposit for a motor vehicle listing Default: False"
          },
          "marketplaceId": {
            "type": "string",
            "description": "The ID of the eBay marketplace to which this payment business policy applies. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "A seller-defined name for this payment business policy. Names must be unique for policies assigned to the same marketplace. Max length: 64",
            "maxLength": 262144
          },
          "paymentInstructions": {
            "type": "string",
            "description": "Note: DO NOT USE THIS FIELD. Payment instructions are no longer supported by payment business policies. A free-form string field that allows sellers to add detailed payment instructions to their listings.",
            "maxLength": 262144
          },
          "paymentMethods": {
            "type": "array",
            "description": "Note: This field applies only when the seller needs to specify one or more offline payment methods. eBay now manages the electronic payment options available to buyers to pay for the item. This array is used to specify one or more offline payment methods that will be accepted for payment that occurs off of eBay's platform.",
            "items": {
              "$ref": "#/$defs/account__PaymentMethod"
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "account__Deposit": {
        "type": "object",
        "description": "This type is used to specify/indicate that an initial deposit is required for a motor vehicle listing.",
        "properties": {
          "amount": {
            "$ref": "#/$defs/account__Amount"
          },
          "dueIn": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "paymentMethods": {
            "type": "array",
            "description": "This array is no longer applicable and should not be used since eBay now manages the electronic payment options available to buyers to pay the deposit.",
            "items": {
              "$ref": "#/$defs/account__PaymentMethod"
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "account__PaymentMethod": {
        "type": "object",
        "description": "This type is used by the paymentMethods container, which is used by the seller to specify one or more offline payment methods. Note : eBay now controls all electronic payment methods available for a marketplace, so a seller will no longer use this type to specify any electronic payment methods.",
        "properties": {
          "brands": {
            "type": "array",
            "description": "Note : This array is no longer applicable and should not be used. eBay now controls all electronic payment methods available for a marketplace, and a seller never has to specify any electronic payment methods, including any credit card brands accepted.",
            "items": {
              "type": "string",
              "description": "For implementation help, refer to eBay API documentation",
              "maxLength": 262144
            },
            "maxItems": 25
          },
          "paymentMethodType": {
            "type": "string",
            "description": "This array is only applicable for listings supporting offline payment methods. See the PaymentMethodTypeEnum type for supported offline payment method enum values. If offline payments are enabled for the policy, provide at least one offline payment method. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "recipientAccountReference": {
            "$ref": "#/$defs/account__RecipientAccountReference"
          }
        },
        "additionalProperties": false
      },
      "account__RecipientAccountReference": {
        "type": "object",
        "description": "Note : This type is no longer applicable. eBay now controls all electronic payment methods available for a marketplace, and a seller never has to specify any electronic payment methods.",
        "properties": {
          "referenceId": {
            "type": "string",
            "description": "Note : DO NOT USE THIS FIELD. eBay now controls all electronic payment methods available for a marketplace, and a seller never has to specify any electronic payment methods.",
            "maxLength": 262144
          },
          "referenceType": {
            "type": "string",
            "description": "Note : DO NOT USE THIS FIELD. eBay now controls all electronic payment methods available for a marketplace, and a seller never has to specify any electronic payment methods. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__ReturnPolicyRequest": {
        "type": "object",
        "description": "This root container defines a seller's return business policy for a specific marketplace and category group. This type is used when creating or updating a return business policy.",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "description": "This container indicates which category group that the return policy applies to. Note : Return business policies are not applicable to motor vehicle listings, so the categoryTypes.name value must be set to ALL_EXCLUDING_MOTORS_VEHICLES for return business policies.",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            },
            "maxItems": 25
          },
          "description": {
            "type": "string",
            "description": "A seller-defined description of the return business policy. This description is only for the seller's use, and is not exposed on any eBay pages. Max length : 250",
            "maxLength": 262144
          },
          "extendedHolidayReturnsOffered": {
            "type": "boolean",
            "description": "Important! This field is deprecated, since eBay no longer supports extended holiday returns. Any value supplied in this field is neither read nor returned."
          },
          "internationalOverride": {
            "$ref": "#/$defs/account__InternationalReturnOverrideType"
          },
          "marketplaceId": {
            "type": "string",
            "description": "The ID of the eBay marketplace to which this return business policy applies. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "A seller-defined name for this return business policy. Names must be unique for policies assigned to the same marketplace. Max length : 64",
            "maxLength": 262144
          },
          "refundMethod": {
            "type": "string",
            "description": "This field sets the refund method to use for returned items. Its value defaults to MONEY_BACK if omitted, so this field is only needed for Buy online, Pickup in Store or Click and Collect items where the seller is willing to offer merchandise credit as an additional refund method to buyers. Getting their money back for returned items is always an option for buyers, regardless of what the seller sets in this field. Important! If this field is not included in a return business policy, it will default to MONEY_BACK . For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "restockingFeePercentage": {
            "type": "string",
            "description": "Important! This field is deprecated, since eBay no longer allows sellers to charge a restocking fee for buyer remorse returns. If this field is included, it is ignored.",
            "maxLength": 262144
          },
          "returnInstructions": {
            "type": "string",
            "description": "This text-based field provides more details on seller-specified return instructions. Important! This field is no longer supported on many eBay marketplaces. To see if a marketplace and eBay category does support this field, call getReturnPolicies method of the Metadata API . Then you will look for the policyDescriptionEnabled field with a value of true for the eBay category. Max length : 5000 (8000 for DE)",
            "maxLength": 262144
          },
          "returnMethod": {
            "type": "string",
            "description": "This field can be used if the seller is willing and able to offer a replacement item as an alternative to 'Money Back'. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "returnPeriod": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "returnsAccepted": {
            "type": "boolean",
            "description": "If set to true , the seller accepts returns. If set to false , the seller does not accept returns. Note: Top-Rated sellers must accept item returns and the handlingTime should be set to zero days or one day for a listing to receive a Top-Rated Plus badge on the View Item or search result pages. For more information on eBay's Top-Rated seller program, see Becoming a Top Rated Seller and qualifying for Top Rated Plus benefits ."
          },
          "returnShippingCostPayer": {
            "type": "string",
            "description": "This field indicates who is responsible for paying for the shipping charges for returned items. The field can be set to either BUYER or SELLER . Note: Eligible Parts & Accessories (P&A) listings require sellers to offer buyers free returns with a minimum return period of 30 days. See Support for easy returns in Parts and Accessories for details. Depending on the return policy and specifics of the return, either the buyer or the seller can be responsible for the return shipping costs. Note that the seller is always responsible for return shipping costs for SNAD-related issues. This field is conditionally required if returnsAccepted is set to true . For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__InternationalReturnOverrideType": {
        "type": "object",
        "description": "This type defines the fields for a seller's international return policy. Sellers have the ability to set separate domestic and international return policies, but if an international return policy is not set, the same return policy settings specified for the domestic return policy are also used for returns for international buyers.",
        "properties": {
          "returnMethod": {
            "type": "string",
            "description": "This field sets/indicates if the seller offers replacement items to the buyer in the case of an international return. The buyer must be willing to accept a replacement item; otherwise, the seller will need to issue a refund for a return. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "returnPeriod": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "returnsAccepted": {
            "type": "boolean",
            "description": "If set to true , the seller accepts international returns. If set to false , the seller does not accept international returns. This field is conditionally required if the seller chooses to have a separate international return policy."
          },
          "returnShippingCostPayer": {
            "type": "string",
            "description": "This field indicates who is responsible for paying for the shipping charges for returned items. The field can be set to either BUYER or SELLER . Depending on the return policy and specifics of the return, either the buyer or the seller can be responsible for the return shipping costs. Note that the seller is always responsible for return shipping costs for 'significantly not as described' (SNAD) issues. This field is conditionally required if the internationalOverride.returnsAccepted field is set to true . For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__BulkEbayOfferDetailsWithKeys": {
        "type": "object",
        "description": "This type is used by the base request of the bulkCreateOffer method, which is used to create up to 25 new offers.",
        "properties": {
          "requests": {
            "type": "array",
            "description": "The details of each offer that is being created is passed in under this container. Up to 25 offers can be created with one bulkCreateOffer call.",
            "items": {
              "$ref": "#/$defs/inventory__EbayOfferDetailsWithKeys"
            },
            "maxItems": 25,
            "minItems": 1
          }
        },
        "additionalProperties": false,
        "required": [
          "requests"
        ]
      },
      "inventory__EbayOfferDetailsWithKeys": {
        "type": "object",
        "description": "This type provides details of an offer, and is used by the base request payload of the createOffer and bulkCreateOffer methods.",
        "properties": {
          "availableQuantity": {
            "type": "integer",
            "description": "This integer value sets the quantity of the inventory item (specified by the sku value) that will be available for purchase by buyers shopping on the eBay site specified in the marketplaceId field. Quantity must be set to 1 or more in order for the inventory item to be purchasable, but this field is not necessarily required, even for published offers, if the general quantity of the inventory item has already been set in the inventory item record. For auction listings, this field should not be provided. Note: The availableQuantity field if set here overrides the quantity field set in the inventory item. See the note in Offer fields for details.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "categoryId": {
            "type": "string",
            "description": "The unique identifier of the eBay category that the product will be listed under. This field is not immediately required upon creating an offer, but will be required before publishing the offer. Sellers can use the getCategorySuggestions method of the Taxonomy API to retrieve suggested category ID values. The seller passes in a query string like \" iPhone 6 \", and category ID values for suggested categories are returned in the response. Important! Publish offer note: This field is required before an offer can be published to create an active listing. Note: When listing in categoryID 173651 (Auto Performance Tuning Devices & Software), use of catalog products is required. For more information, see Tuning devices and software .",
            "maxLength": 262144
          },
          "charity": {
            "$ref": "#/$defs/inventory__Charity"
          },
          "extendedProducerResponsibility": {
            "$ref": "#/$defs/inventory__ExtendedProducerResponsibility"
          },
          "format": {
            "type": "string",
            "description": "This enumerated value indicates the listing format of the offer. Supported values are FIXED_PRICE and AUCTION . For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "hideBuyerDetails": {
            "type": "boolean",
            "description": "This field is included and set to true if the seller wishes to create a private listing. Sellers may want to use this option when they believe that a listing's potential bidders/buyers would not want their obfuscated user IDs (and feedback scores) exposed to other users."
          },
          "includeCatalogProductDetails": {
            "type": "boolean",
            "description": "This field indicates whether or not eBay product catalog details are applied to a listing. A value of true indicates the listing corresponds to the eBay product associated with the provided product identifier. The product identifier is provided in createOrReplaceInventoryItem . Default: true Note: Though the includeCatalogProductDetails parameter is not required to be submitted in the request, the parameter defaults to true if omitted."
          },
          "listingDescription": {
            "type": "string",
            "description": "The text in this field is (published offers), or will become (unpublished offers) the description of the eBay listing. This field is not immediately required for an unpublished offer, but will be required before publishing the offer. Note that if the listingDescription field was omitted in the createOffer call for the offer, the offer entity should have picked up the text provided in the product.description field of the inventory item record, or if the inventory item is part of a group, the offer entity should have picked up the text provided in the description field of the inventory item group record. HTML tags and markup can be used in listing descriptions, but each character counts toward the max length limit. Note: To ensure that their short listing description is optimized when viewed on mobile devices, sellers should strongly consider using eBay's View Item description summary feature when listing their items. Keep in mind that the 'short' listing description is what prospective buyers first see when they view the listing on a mobile device. The 'full' listing description is also available to mobile users when they click on the short listing description, but the full description is not automatically optimized for viewing in mobile devices, and many users won't even drill down to the full description. Using HTML div and span tag attributes, this feature allows sellers to customize and fully control the short listing description that is displayed to prospective buyers when viewing the listing on a mobile device. The short listing description on mobile devices is limited to 800 characters, and whenever the full listing description (provided in this field, in UI, or seller tool) exceeds this limit, eBay uses a special algorithm to derive the best possible short listing description within the 800-character limit. However, due to some short listing description content being removed, it is definitely not ideal for the seller, and could lead to a bad buyer experience and possibly to a Significantly not as described (SNAD) case, since the buyer may not get complete details on the item when viewing the short listing description. See the eBay help page for more details on using the HTML div and span tags. Max length : 500000 (which includes HTML markup/tags)",
            "maxLength": 262144
          },
          "listingDuration": {
            "type": "string",
            "description": "This field indicates the number of days that the listing will be active. For fixed-price listings, this value must be set to GTC , but auction listings support different listing durations. The GTC (Good 'Til Cancelled) listings are automatically renewed each calendar month until the seller decides to end the listing. Note: If the listing duration expires for an auction offer without a winning bidder, the listing then becomes available as a fixed-price offer and listing duration will be GTC . Important! Publish offer note: This field is required before an offer can be published to create an active listing. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "listingPolicies": {
            "$ref": "#/$defs/inventory__ListingPolicies"
          },
          "listingStartDate": {
            "type": "string",
            "description": "This field can be used if the seller wants to specify a time in the future that the listing will become active on eBay. The timestamp supplied in this field should be in UTC format, and it should be far enough in the future so that the seller will have enough time to publish the listing with the publishOffer method. For example: 2023-05-30T19:08:00Z. This field is optional. If this field is not provided, the listing starts immediately after a successful publishOffer method.",
            "maxLength": 262144
          },
          "lotSize": {
            "type": "integer",
            "description": "This field is only applicable if the listing is a lot listing. A lot listing is a listing that has multiple quantity of the same item, such as four identical tires being sold as a single offer, or it can be a mixed lot of similar items, such as used clothing items or an assortment of baseball cards. Whether the lot listing involved identical items or a mixed lot, the integer value passed into this field is the total number of items in the lot. Lots can be used for auction and fixed-price listings.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "marketplaceId": {
            "type": "string",
            "description": "This enumeration value is the unique identifier of the eBay site for which the offer will be made available. See MarketplaceEnum for the list of supported enumeration values. This field is required. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "merchantLocationKey": {
            "type": "string",
            "description": "The unique identifier of a merchant's inventory location (where the inventory item in the offer is located). To get more information about inventory locations, the getInventoryLocations method can be used. Note: This field is not initially required upon first creating an offer, but will become required before an offer can be published. Important! Publish offer note: This field is required before an offer can be published to create an active listing. Max length : 36",
            "maxLength": 262144
          },
          "pricingSummary": {
            "$ref": "#/$defs/inventory__PricingSummary"
          },
          "quantityLimitPerBuyer": {
            "type": "integer",
            "description": "This field is only applicable and set if the seller wishes to set a restriction on the purchase quantity per seller. If this field is set by the seller for the offer, then each distinct buyer may purchase up to, but not exceed the quantity specified for this field. So, if this field's value is 5 , each buyer may purchase between one to five of these products, and the purchases can occur in one multiple-quantity purchase, or over multiple transactions. If a buyer attempts to purchase one or more of these products, and the cumulative quantity will take the buyer beyond the quantity limit, that buyer will be blocked from that purchase.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "regulatory": {
            "$ref": "#/$defs/inventory__Regulatory"
          },
          "secondaryCategoryId": {
            "type": "string",
            "description": "The unique identifier for a secondary category. This field is applicable if the seller decides to list the item under two categories. Sellers can use the getCategorySuggestions method of the Taxonomy API to retrieve suggested category ID values. A fee may be charged when adding a secondary category to a listing. Note: You cannot list US eBay Motors vehicles in two categories. However, you can list Parts & Accessories in two categories. Note: When listing in categoryID 173651 (Auto Performance Tuning Devices & Software), use of catalog products is required. For more information, see Tuning devices and software .",
            "maxLength": 262144
          },
          "sku": {
            "type": "string",
            "description": "The seller-defined SKU value of the product that will be listed on the eBay site (specified in the marketplaceId field). Only one offer (in unpublished or published state) may exist for each sku / marketplaceId / format combination. This field is required. Use the getInventoryItems method to retrieve SKU values. Max Length : 50",
            "maxLength": 262144
          },
          "storeCategoryNames": {
            "type": "array",
            "description": "This container is used if the seller would like to place the inventory item into one or two eBay store categories that the seller has set up for their eBay store. The string value(s) passed in to this container will be the full path(s) to the eBay store categories, as shown below: \"storeCategoryNames\": [ \"/Fashion/Men/Shirts\", \"/Fashion/Men/Accessories\" ],",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 25
          },
          "tax": {
            "$ref": "#/$defs/inventory__Tax"
          }
        },
        "additionalProperties": false
      },
      "inventory__Charity": {
        "type": "object",
        "description": "This type is used to identify the charitable organization associated with the listing, and the percentage of the sale proceeds that the charitable organization will receive for each sale generated by the listing. In order to receive a percentage of the sales proceeds, the charitable organization must be registered with the PayPal Giving Fund, which is a partner of eBay for Charity.",
        "properties": {
          "charityId": {
            "type": "string",
            "description": "The eBay-assigned unique identifier of the charitable organization that will receive a percentage of the sales proceeds. The charitable organization must be reqistered with the PayPal Giving Fund in order to receive sales proceeds through eBay listings. This field is conditionally required if a seller is planning on donating a percentage of the sale proceeds to a charitable organization. The eBay-assigned unique identifier of a charitable organization can be found using the getCharityOrgs method of the Charity API. In the getCharityOrgs response, this unique identifier is shown in the charityOrgId field.",
            "maxLength": 262144
          },
          "donationPercentage": {
            "type": "string",
            "description": "This field is the percentage of the purchase price that the charitable organization (identified in the charityId field) will receive for each sale that the listing generates. This field is conditionally required if a seller is planning on donating a percentage of the sale proceeds to a charitable organization. This numeric value can range from 10 to 100, and in any 5 (percent) increments in between this range (e.g. 10 , 15 , 20 ... 95 ,... 100 ). The seller would pass in 10 for 10 percent, 15 for 15 percent, 20 for 20 percent, and so on, all the way to 100 for 100 percent.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__ExtendedProducerResponsibility": {
        "type": "object",
        "description": "This type provides IDs for the producer or importer related to the new item, packaging, added documentation, or an eco-participation fee. In some markets, such as in France, this may be the importer of the item.",
        "properties": {
          "ecoParticipationFee": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "producerProductId": {
            "type": "string",
            "description": "Note: THIS FIELD IS DEPRECATED AND NO LONGER SUPPORTED. For sellers selling on the eBay France Marketplace, Extended Producer Responsibility ID fields are no longer set at the listing level. Instead, sellers must provide these IDs for each applicable category in their My eBay accounts. The URL will be based on the seller's home/registration site, and will use this pattern: https://accountsettings./epr-fr. Sellers based in the US will use https://accountsettings.ebay.com/epr-fr , sellers based in France will use https://accountsettings.ebay.fr/epr-fr , and so on.",
            "maxLength": 262144
          },
          "productDocumentationId": {
            "type": "string",
            "description": "Note: THIS FIELD IS DEPRECATED AND NO LONGER SUPPORTED. For sellers selling on the eBay France Marketplace, Extended Producer Responsibility ID fields are no longer set at the listing level. Instead, sellers must provide these IDs for each applicable category in their My eBay accounts. The URL will be based on the seller's home/registration site, and will use this pattern: https://accountsettings./epr-fr. Sellers based in the US will use https://accountsettings.ebay.com/epr-fr , sellers based in France will use https://accountsettings.ebay.fr/epr-fr , and so on.",
            "maxLength": 262144
          },
          "productPackageId": {
            "type": "string",
            "description": "Note: THIS FIELD IS DEPRECATED AND NO LONGER SUPPORTED. For sellers selling on the eBay France Marketplace, Extended Producer Responsibility ID fields are no longer set at the listing level. Instead, sellers must provide these IDs for each applicable category in their My eBay accounts. The URL will be based on the seller's home/registration site, and will use this pattern: https://accountsettings./epr-fr. Sellers based in the US will use https://accountsettings.ebay.com/epr-fr , sellers based in France will use https://accountsettings.ebay.fr/epr-fr , and so on.",
            "maxLength": 262144
          },
          "shipmentPackageId": {
            "type": "string",
            "description": "Note: THIS FIELD IS DEPRECATED AND NO LONGER SUPPORTED. For sellers selling on the eBay France Marketplace, Extended Producer Responsibility ID fields are no longer set at the listing level. Instead, sellers must provide these IDs for each applicable category in their My eBay accounts. The URL will be based on the seller's home/registration site, and will use this pattern: https://accountsettings./epr-fr. Sellers based in the US will use https://accountsettings.ebay.com/epr-fr , sellers based in France will use https://accountsettings.ebay.fr/epr-fr , and so on.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__Amount": {
        "type": "object",
        "description": "This type is used to express a dollar value and the applicable currency.",
        "properties": {
          "currency": {
            "type": "string",
            "description": "A three-digit string value representing the type of currency being used. Both the value and currency fields are required/always returned when expressing prices. See the CurrencyCodeEnum type for the full list of currencies and their corresponding three-digit string values.",
            "maxLength": 262144
          },
          "value": {
            "type": "string",
            "description": "A string representation of a dollar value expressed in the currency specified in the currency field. Both the value and currency fields are required/always returned when expressing prices.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__ListingPolicies": {
        "type": "object",
        "description": "This type is used to identify business policies including payment, return, and fulfillment policies, as well as to identify custom policies. These policies are, or will be, associated with the listing. Every published offer must have a payment, return, and fulfillment business policy associated with it. Additionally, depending on the country/countries in which sellers are offering products and/or services to consumers (e.g., residents of the European Union,) specifying additional polices may be required. This type is also used to override the shipping costs of one or more shipping service options that are associated with the fulfillment policy, to enable eBay Plus eligibility for a listing, or to enable the Best Offer feature on the listing.",
        "properties": {
          "bestOfferTerms": {
            "$ref": "#/$defs/inventory__BestOffer"
          },
          "eBayPlusIfEligible": {
            "type": "boolean",
            "description": "This field is included in an offer and set to true if a Top-Rated seller is opted in to the eBay Plus program. With the eBay Plus program, qualified sellers must commit to next-day delivery of the item, and the buyers must have an eBay Plus subscription to be eligible to receive the benefits of this program, which are free, next-day delivery, as well as free returns. Note: Currently, this program is only available on the Germany and Australian sites. This field will be returned in the getOffer and getOffers methods if set for the offer."
          },
          "fulfillmentPolicyId": {
            "type": "string",
            "description": "This unique identifier indicates the fulfillment business policy that will be used once an offer is published and converted to an eBay listing. This fulfillment business policy will set all fulfillment-related settings for the eBay listing. Business policies are not immediately required for offers, but are required before an offer can be published. The seller should review the fulfillment business policy before assigning it to the offer to make sure it is compatible with the inventory item and the offer settings. The seller may also want to review the shipping service costs in the fulfillment policy, and that seller might decide to override the shipping costs for one or more shipping service options by using the shippingCostOverrides container. Business policies can be created and managed in My eBay or with the Account API . To get a list of all return policies associated with a seller's account on a specific eBay Marketplace, use the Account API's getFulfillmentPolicies method. There are also calls in the Account API to retrieve a fulfillment policy by policy ID or policy name. This field will be returned in the getOffer and getOffers methods if set for the offer. Important! Publish offer note: This field is required before an offer can be published to create an active listing.",
            "maxLength": 262144
          },
          "paymentPolicyId": {
            "type": "string",
            "description": "This unique identifier indicates the payment business policy that will be used once an offer is published and converted to an eBay listing. This payment business policy will set all payment-related settings for the eBay listing. Business policies are not immediately required for offers, but are required before an offer can be published. The seller should review the payment business policy to make sure that it is compatible with the marketplace and listing category before assigning it to the offer. Business policies can be created and managed in My eBay or with the Account API . To get a list of all payment policies associated with a seller's account on a specific eBay Marketplace, use the Account API's getPaymentPolicies method. There are also calls in the Account API to retrieve a payment policy by policy ID or policy name. This field will be returned in the getOffer and getOffers methods if set for the offer. Important! Publish offer note: This field is required before an offer can be published to create an active listing.",
            "maxLength": 262144
          },
          "productCompliancePolicyIds": {
            "type": "array",
            "description": "This field contains the array of unique identifiers indicating the seller-created global product compliance policies that will be used once an offer is published and converted to a listing. Product compliance policies provide buyers with important information and disclosures about products. For example, if you sell batteries and specific disclosures are required to be shared with all potential buyers, your global product compliance policy could contain the required disclosures. A maximum of six (6) global product compliance policies may apply to each offer . Note: For countries that support country-specific policies, use regionalProductCompliancePolicies to apply them to an offer.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 25
          },
          "regionalProductCompliancePolicies": {
            "$ref": "#/$defs/inventory__RegionalProductCompliancePolicies"
          },
          "regionalTakeBackPolicies": {
            "$ref": "#/$defs/inventory__RegionalTakeBackPolicies"
          },
          "returnPolicyId": {
            "type": "string",
            "description": "This unique identifier indicates the return business policy that will be used once an offer is published and converted to an eBay listing. This return business policy will set all return policy settings for the eBay listing. Note: As a part of Digital Services Act (DSA) requirements, as of April 3, 2023, buyers in the EU must be allowed to return an item within 14 days or more, unless the item is exempt. Where applicable, sellers should update their return policies to reflect this requirement of accepting returns from EU buyers. Business policies are not immediately required for offers, but are required before an offer can be published. The seller should review the return business policy before assigning it to the offer to make sure it is compatible with the inventory item and the offer settings. Business policies can be created and managed in My eBay or with the Account API . To get a list of all return policies associated with a seller's account on a specific eBay Marketplace, use the Account API's getReturnPolicies call. There are also calls in the Account API to retrieve a return policy by policy ID or policy name. This field will be returned in the getOffer and getOffers methods if set for the offer. Important! Publish offer note: This field is required before an offer can be published to create an active listing.",
            "maxLength": 262144
          },
          "shippingCostOverrides": {
            "type": "array",
            "description": "This container is used if the seller wishes to override the shipping costs or surcharge for one or more domestic or international shipping service options defined in the fulfillment listing policy. To override the costs of a specific domestic or international shipping service option, the seller must know the priority/order of that shipping service in the fulfillment listing policy. The name of a shipping service option can be found in the shippingOptions.shippingServices.shippingServiceCode field of the fulfillment policy, and the priority/order of that shipping service option is found in the shippingOptions.shippingServices.sortOrderId field. Both of these values can be retrieved by searching for that fulfillment policy with the getFulfillmentPolicies or getFulfillmentPolicyByName calls of the Account API . The shippingCostOverrides.priority value should match the shippingOptions.shippingServices.sortOrderId in order to override the shipping costs for that shipping service option. The seller must also ensure that the shippingServiceType value is set to DOMESTIC to override a domestic shipping service option, or to INTERNATIONAL to override an international shipping service option. A separate ShippingCostOverrides node is needed for each shipping service option whose costs are being overridden. All defined fields of the shippingCostOverrides container should be included, even if the shipping costs and surcharge values are not changing. The shippingCostOverrides container is returned in the getOffer and getOffers calls if one or more shipping cost overrides are being applied to the fulfillment policy.",
            "items": {
              "$ref": "#/$defs/inventory__ShippingCostOverride"
            },
            "maxItems": 25
          },
          "takeBackPolicyId": {
            "type": "string",
            "description": "This unique identifier indicates the seller-created global take-back policy that will be used once an offer is published and converted to a listing. One (1) global take-back policy may be specified per offer . Note: For countries that support country-specific policies, use regionalTakeBackPolicies to apply them to an offer.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__BestOffer": {
        "type": "object",
        "description": "This type is used by the bestOfferTerms container, which is used if the seller would like to support the Best Offer feature on their listing.",
        "properties": {
          "autoAcceptPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "autoDeclinePrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "bestOfferEnabled": {
            "type": "boolean",
            "description": "This field indicates whether or not the Best Offer feature is enabled for the listing. A seller can enable the Best Offer feature for a listing as long as the category supports the Best Offer feature. The seller includes this field and sets its value to true to enable Best Offer feature. Note: Best Offer is not available for multi-variation listings."
          }
        },
        "additionalProperties": false
      },
      "inventory__RegionalProductCompliancePolicies": {
        "type": "object",
        "description": "This type lists regional product compliance policies to be used by an offer when it is published and converted to a listing.",
        "properties": {
          "countryPolicies": {
            "type": "array",
            "description": "The array of country-specific product compliance policies to be used by an offer when it is published and converted to a listing.",
            "items": {
              "$ref": "#/$defs/inventory__CountryPolicy"
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "inventory__CountryPolicy": {
        "type": "object",
        "description": "This type specifies custom product compliance and/or take-back policies that apply to a specified country.",
        "properties": {
          "country": {
            "type": "string",
            "description": "The two-letter ISO 3166-1 country code identifying the country to which the policy or policies specified in the corresponding policyIds array will apply. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "policyIds": {
            "type": "array",
            "description": "An array of custom policy identifiers that apply to the country specified by listingPolicies.regionalTakeBackPolicies.countryPolicies.country . Product compliance and take-back policy information may be returned using the following methods: getCustomPolicies Set policy_types to: PRODUCT_COMPLIANCE for product compliance policies TAKE_BACK for takeback policies This returns the list of specified policies and corresponding customPolicyId values a seller has created. getCustomPolicy with custom_policy_id = customPolicyId Returns the details of the policy specified by customPolicyId For information about creating and managing custom policies, refer to the custom_policy resource in the Sell Account API.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "inventory__RegionalTakeBackPolicies": {
        "type": "object",
        "description": "This type lists regional take-back policies to be used by an offer when it is published and converted to a listing.",
        "properties": {
          "countryPolicies": {
            "type": "array",
            "description": "The array of country-specific take-back policies to be used by an offer when it is published and converted to a listing.",
            "items": {
              "$ref": "#/$defs/inventory__CountryPolicy"
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "inventory__ShippingCostOverride": {
        "type": "object",
        "description": "This type is used if the seller wants to override the shipping costs or surcharge associated with a specific domestic or international shipping service option defined in the fulfillment listing policy that is being applied toward the offer. The shipping-related costs that can be overridden include the shipping cost to ship one item, the shipping cost to ship each additional item (if multiple quantity are purchased), and the shipping surcharge applied to the shipping service option.",
        "properties": {
          "additionalShippingCost": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "priority": {
            "type": "integer",
            "description": "The integer value input into this field, along with the shippingServiceType value, sets which domestic or international shipping service option in the fulfillment policy will be modified with updated shipping costs. Specifically, the shippingCostOverrides.shippingServiceType value in a createOffer or updateOffer call must match the shippingOptions.optionType value in a fulfillment listing policy, and the shippingCostOverrides.priority value in a createOffer or updateOffer call must match the shippingOptions.shippingServices.sortOrderId value in a fulfillment listing policy. This field is always required when overriding the shipping costs of a shipping service option, and will be always be returned for each shipping service option whose costs are being overridden.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "shippingCost": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "shippingServiceType": {
            "type": "string",
            "description": "This enumerated value indicates whether the shipping service specified in the priority field is a domestic or an international shipping service option. To override the shipping costs for a specific domestic shipping service in the fulfillment listing policy, this field should be set to DOMESTIC , and to override the shipping costs for each international shipping service, this field should be set to INTERNATIONAL . This value, along with priority value, sets which domestic or international shipping service option in the fulfillment policy that will be modified with updated shipping costs. Specifically, the shippingCostOverrides.shippingServiceType value in a createOffer or updateOffer call must match the shippingOptions.optionType value in a fulfillment listing policy, and the shippingCostOverrides.priority value in a createOffer or updateOffer call must match the shippingOptions.shippingServices.sortOrderId value in a fulfillment listing policy. This field is always required when overriding the shipping costs of a shipping service option, and will be always be returned for each shipping service option whose costs are being overridden. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "surcharge": {
            "$ref": "#/$defs/inventory__Amount"
          }
        },
        "additionalProperties": false
      },
      "inventory__PricingSummary": {
        "type": "object",
        "description": "This type is used to specify the listing price for the product and settings for the Minimum Advertised Price and Strikethrough Pricing features. The price field must be supplied before an offer is published, but a seller may create an offer without supplying a price initially. The Minimum Advertised Price feature is only available on the US site. Strikethrough Pricing is available on the US, eBay Motors, UK, Germany, Canada (English and French), France, Italy, and Spain sites.",
        "properties": {
          "auctionReservePrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "auctionStartPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "minimumAdvertisedPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "originallySoldForRetailPriceOn": {
            "type": "string",
            "description": "This field is needed if the Strikethrough Pricing (STP) feature will be used in the offer. This field indicates that the product was sold for the price in the originalRetailPrice field on an eBay site, or sold for that price by a third-party retailer. When using the createOffer or updateOffer calls, the seller will pass in a value of ON_EBAY to indicate that the product was sold for the originalRetailPrice on an eBay site, or the seller will pass in a value of OFF_EBAY to indicate that the product was sold for the originalRetailPrice through a third-party retailer. This field and the originalRetailPrice field are only applicable if the seller and listing are eligible to use the Strikethrough Pricing feature, a feature which is limited to the US (core site and Motors), UK, Germany, Canada (English and French versions), France, Italy, and Spain sites. This field will be returned by getOffer and getOffers if set for the offer. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "originalRetailPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "price": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "pricingVisibility": {
            "type": "string",
            "description": "This field is needed if the Minimum Advertised Price (MAP) feature will be used in the offer. This field is only applicable if an eligible US seller is using the Minimum Advertised Price (MAP) feature and a minimumAdvertisedPrice has been specified. The value set in this field will determine whether the MAP price is shown to a prospective buyer prior to checkout through a pop-up window accessed from the View Item page, or if the MAP price is not shown until the checkout flow after the buyer has already committed to buying the item. To show the MAP price prior to checkout, the seller will set this value to PRE_CHECKOUT . To show the MAP price after the buyer already commits to buy the item, the seller will set this value to DURING_CHECKOUT . This field will be ignored if the seller and/or the listing is not eligible for the MAP feature. This field will be returned by getOffer and getOffers if set for the offer. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__Regulatory": {
        "type": "object",
        "description": "Type defining regulatory information that the seller is required to disclose.",
        "properties": {
          "documents": {
            "type": "array",
            "description": "This container provides a collection of regulatory documents associated with the listing. For information on removing one or more files from a listing using the updateOffer method, see Remove documents from listings. . Note: As a part of General Product Safety Regulation (GPSR) requirements effective on December 13th, 2024, sellers operating in, or shipping to, EU-based countries or Northern Ireland are conditionally required to provide regulatory document information in their eBay listings. For more information on GPSR, see General Product Safety Regulation (GPSR) .",
            "items": {
              "$ref": "#/$defs/inventory__Document"
            },
            "maxItems": 25
          },
          "energyEfficiencyLabel": {
            "$ref": "#/$defs/inventory__EnergyEfficiencyLabel"
          },
          "hazmat": {
            "$ref": "#/$defs/inventory__Hazmat"
          },
          "manufacturer": {
            "$ref": "#/$defs/inventory__Manufacturer"
          },
          "productSafety": {
            "$ref": "#/$defs/inventory__ProductSafety"
          },
          "repairScore": {
            "type": "number",
            "description": "This field represents the repair index for the listing. The repair index identifies the manufacturer's repair score for a product (i.e., how easy is it to repair the product.) This field is a floating point value between 0.0 (i.e., difficult to repair,) and 10.0 (i.e., easily repaired.) Note: 0 should not be used as a default value, as it implies the product is not repairable. The format for repairScore is limited to one decimal place. For example: 7.9 and 0.0 are both valid scores 5.645 and 2.10 are both invalid scores Note: Repair score is not applicable to all categories. Use the getExtendedProducerResponsibilityPolicies method of the Metadata API to see where repair score is applicable."
          },
          "responsiblePersons": {
            "type": "array",
            "description": "This container provides information about the EU-based Responsible Persons or entities associated with the listing. A maximum of 5 EU Responsible Persons are supported. Note: As a part of General Product Safety Regulation (GPSR) requirements effective on December 13th, 2024, sellers operating in, or shipping to, EU-based countries or Northern Ireland are conditionally required to provide regulatory Responsible Persons information in their eBay listings. For more information on GPSR, see General Product Safety Regulation (GPSR) .",
            "items": {
              "$ref": "#/$defs/inventory__ResponsiblePerson"
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "inventory__Document": {
        "type": "object",
        "description": "This type provides an array of one or more regulatory documents associated with a listing for Regulatory Compliance.",
        "properties": {
          "documentId": {
            "type": "string",
            "description": "The unique identifier of a regulatory document associated with the listing. This value can be found in the response of the createDocument method of the Media API.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__EnergyEfficiencyLabel": {
        "type": "object",
        "description": "This type provides information about the energy efficiency for certain durable goods. Important! When providing energy efficiency information on an appliance or smartphones and tablets listing, the energy efficiency rating and range of the item must be specified through the the aspects field when creating the inventory item record. Use the getItemAspectsForCategory method of the Taxonomy API to retrieve applicable rating and range values for a specified category.",
        "properties": {
          "imageDescription": {
            "type": "string",
            "description": "A brief verbal summary of the information included on the Energy Efficiency Label for an item. For example, On a scale of A to G the rating is E.",
            "maxLength": 262144
          },
          "imageURL": {
            "type": "string",
            "description": "The URL to the Energy Efficiency Label image that is applicable to an item.",
            "maxLength": 262144
          },
          "productInformationSheet": {
            "type": "string",
            "description": "The URL to the Product Information Sheet that provides complete manufacturer-provided efficiency information about an item.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__Hazmat": {
        "type": "object",
        "description": "This container is used by the seller to provide hazardous material information for the listing. The statements element is required to complete the hazmat section of a listing. The following elements are optional: pictograms signalWord component",
        "properties": {
          "component": {
            "type": "string",
            "description": "This field is used by the seller to provide component information for the listing. For example, component information can provide the specific material of Hazmat concern. Max length: 120",
            "maxLength": 262144
          },
          "pictograms": {
            "type": "array",
            "description": "An array of comma-separated string values listing applicable pictogram code(s) for Hazard Pictogram(s). If your product contains hazardous substances or mixtures, please select the values corresponding to the hazard pictograms that are stated on your product's Safety Data Sheet. The selected hazard information will be displayed on your listing. Note: Use the getHazardousMaterialsLabels method in the Metadata API to find supported values for a specific marketplace/site. Refer to Pictogram sample values for additional information.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 25
          },
          "signalWord": {
            "type": "string",
            "description": "This field sets the signal word for hazardous materials in the listing. If your product contains hazardous substances or mixtures, please select a value corresponding to the signal word that is stated on your product's Safety Data Sheet. The selected hazard information will be displayed on your listing. Note: Use the getHazardousMaterialsLabels method in the Metadata API to find supported values for a specific marketplace/site. Refer to Signal word information for additional information.",
            "maxLength": 262144
          },
          "statements": {
            "type": "array",
            "description": "An array of comma-separated string values specifying applicable statement code(s) for hazard statement(s) for the listing. If your product contains hazardous substances or mixtures, please select the values corresponding to the hazard statements that are stated on your product's Safety Data Sheet. The selected hazard information will be displayed on your listing. Note: Use the getHazardousMaterialsLabels method in the Metadata API to find supported values for a specific marketplace/site. Refer to Hazard statement sample values for additional information. This field is required if hazardous material information is provided for the listing.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "inventory__Manufacturer": {
        "type": "object",
        "description": "This type provides name and contact information about the manufacturer of the item.",
        "properties": {
          "addressLine1": {
            "type": "string",
            "description": "The first line of the product manufacturer's street address. Max length : 180 characters",
            "maxLength": 262144
          },
          "addressLine2": {
            "type": "string",
            "description": "The second line of the product manufacturer's street address. This field is not always used, but can be used for secondary address information such as 'Suite Number' or 'Apt Number'. Max length : 180 characters",
            "maxLength": 262144
          },
          "city": {
            "type": "string",
            "description": "The city of the product manufacturer's street address. Max length : 64 characters",
            "maxLength": 262144
          },
          "companyName": {
            "type": "string",
            "description": "The company name of the product manufacturer. Max length : 100 characters",
            "maxLength": 262144
          },
          "contactUrl": {
            "type": "string",
            "description": "The contact URL of the product manufacturer. Max length : 250 characters",
            "maxLength": 262144
          },
          "country": {
            "type": "string",
            "description": "This defines the list of valid country codes, adapted from http://www.iso.org/iso/country_codes, ISO 3166-1 country code. List elements take the following form to identify a two-letter code with a short name in English, a three-digit code, and a three-letter code: For example, the entry for Japan includes Japan, 392, JPN. Short codes provide uniform recognition, avoiding language-dependent country names. The number code is helpful where Latin script may be problematic. Not all listed codes are universally recognized as countries, for example: code AQ is Antarctica, 010, ATA For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "email": {
            "type": "string",
            "description": "The product manufacturer's business email address. Max length : 180 characters",
            "maxLength": 262144
          },
          "phone": {
            "type": "string",
            "description": "The product manufacturer's business phone number. Max length : 64 characters",
            "maxLength": 262144
          },
          "postalCode": {
            "type": "string",
            "description": "The postal code of the product manufacturer's street address. Max length : 9 characters",
            "maxLength": 262144
          },
          "stateOrProvince": {
            "type": "string",
            "description": "The state or province of the product manufacturer's street address. Max length : 64 characters",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__ProductSafety": {
        "type": "object",
        "description": "This type is used to define the pictograms and statement containers, and the optional component field, that provide product safety and compliance related information.",
        "properties": {
          "component": {
            "type": "string",
            "description": "This field is used by the seller to provide product safety component information for the listing. For example, component information can include specific warnings related to product safety, such as 'Tipping hazard'. Note: Component information can only be specified if used with the pictograms and/or statements field; if the component is provided without one or both of these fields, an error will occur. Max length: 120 characters",
            "maxLength": 262144
          },
          "pictograms": {
            "type": "array",
            "description": "An array of comma-separated string values used to provide product safety pictogram(s) for the listing. If your product shows universal product safety or compliance symbols, please select the values corresponding to the product safety pictograms for display in the product safety section of the listing. The seller specifies the identifier of each pictogram in this field. Note: For product safety pictograms, use the getProductSafetyLabels method of the Metadata API to find supported values for a specific marketplace/site. A maximum of 2 pictograms are allowed for product safety.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 25
          },
          "statements": {
            "type": "array",
            "description": "An array of comma-separated string values used to provide product safety statement(s) for the listing. If your product shows universal product safety or compliance warnings, please select the values corresponding to the product safety statements for display in the product safety section of the listing. The seller specifies the identifier of each statement in this field. Note: For product safety statements, use the getProductSafetyLabels method of the Metadata API to find supported values for a specific marketplace/site. A maximum of 8 statements are allowed for product safety.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "inventory__ResponsiblePerson": {
        "type": "object",
        "description": "This type provides information, such as name and contact details, for an EU-based Responsible Person or entity, associated with the product.",
        "properties": {
          "addressLine1": {
            "type": "string",
            "description": "The first line of the Responsible Person's street address. Max length : 180 characters",
            "maxLength": 262144
          },
          "addressLine2": {
            "type": "string",
            "description": "The second line of the Responsible Person's address. This field is not always used, but can be used for secondary address information such as 'Suite Number' or 'Apt Number'. Max length : 180 characters",
            "maxLength": 262144
          },
          "city": {
            "type": "string",
            "description": "The city of the Responsible Person's street address. Max length : 64 characters",
            "maxLength": 262144
          },
          "companyName": {
            "type": "string",
            "description": "The name of the Responsible Person or entity. Max length : 100 characters",
            "maxLength": 262144
          },
          "contactUrl": {
            "type": "string",
            "description": "The contact URL of the Responsible Person or entity. Max length : 250 characters",
            "maxLength": 262144
          },
          "country": {
            "type": "string",
            "description": "This defines the list of valid country codes, adapted from http://www.iso.org/iso/country_codes, ISO 3166-1 country code. List elements take the following form to identify a two-letter code with a short name in English, a three-digit code, and a three-letter code: For example, the entry for Japan includes Japan, 392, JPN. Short codes provide uniform recognition, avoiding language-dependent country names. The number code is helpful where Latin script may be problematic. Not all listed codes are universally recognized as countries, for example: code AQ is Antarctica, 010, ATA For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "email": {
            "type": "string",
            "description": "The Responsible Person's email address. Max length : 180 characters",
            "maxLength": 262144
          },
          "phone": {
            "type": "string",
            "description": "The Responsible Person's business phone number. Max length : 64 characters",
            "maxLength": 262144
          },
          "postalCode": {
            "type": "string",
            "description": "The postal code of the Responsible Person's street address. Max length : 9 characters",
            "maxLength": 262144
          },
          "stateOrProvince": {
            "type": "string",
            "description": "The state of province of the Responsible Person's street address. Max length : 64 characters",
            "maxLength": 262144
          },
          "types": {
            "type": "array",
            "description": "The type(s) associated with the Responsible Person or entity. Note: Currently, the only supported value is EUResponsiblePerson .",
            "items": {
              "type": "string",
              "description": "For implementation help, refer to eBay API documentation",
              "maxLength": 262144
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "inventory__Tax": {
        "type": "object",
        "description": "This type is used to enable the use of a sales-tax table, to pass in a tax exception category code, or to specify a VAT percentage. Note: Sales-tax tables are available only for the US and Canada marketplaces.",
        "properties": {
          "applyTax": {
            "type": "boolean",
            "description": "When set to true , the seller's account-level sales-tax table will be used to calculate sales tax for an order. Note: Sales-tax tables are available only for the US and Canada marketplaces. Important! In the US, eBay now calculates, collects, and remits sales tax to the proper taxing authorities in all 50 states and Washington, DC. Sellers can no longer specify sales-tax rates for these jurisdictions using a tax table. However, sellers may continue to use a sales-tax table to set rates for the following US territories: American Samoa (AS) Guam (GU) Northern Mariana Islands (MP) Palau (PW) US Virgin Islands (VI) For complete information about using sales-tax tables, refer to Establishing sales-tax tables . Note that a seller can enable the use of a sales-tax table, but if a sales-tax rate is not specified for the buyer's tax jurisdiction, sales tax will not be applied to the order. When a thirdPartyTaxCategory value is used, applyTax must also be set to true . This field will be returned by getOffer and getOffers if set for the offer. For additional information, refer to Taxes and import charges ."
          },
          "thirdPartyTaxCategory": {
            "type": "string",
            "description": "The tax exception category code. If this field is used, sales tax will also apply to a service/fee, and not just the item price. This is to be used only by sellers who have opted into sales tax being calculated by a sales tax calculation vendor. If you are interested in becoming a tax calculation vendor partner with eBay, contact developer-relations@ebay.com . One supported value for this field is WASTE_RECYCLING_FEE . If this field is used, the applyTax field must also be used and set to true This field will be returned by getOffer and getOffers if set for the offer.",
            "maxLength": 262144
          },
          "vatPercentage": {
            "type": "number",
            "description": "This value is the Value Add Tax (VAT) rate for the item, if any. When a VAT percentage is specified, the item's VAT information appears on the listing's View Item page. In addition, the seller can choose to print an invoice that includes the item's net price, VAT percent, VAT amount, and total price. Since VAT rates vary depending on the item and on the user's country of residence, a seller is responsible for entering the correct VAT rate; it is not calculated by eBay. To use VAT, a seller must be a business seller with a VAT-ID registered with eBay, and must be listing the item on a VAT-enabled site. Max applicable length is 6 characters, including the decimal (e.g., 12.345). The scale is 3 decimal places. (If you pass in 12.3456, eBay may round up the value to 12.346). This field will be returned by getOffer and getOffers if set for the offer."
          }
        },
        "additionalProperties": false
      }
    },
    "H": {
      "account__CustomPolicyRequest": {
        "type": "object",
        "properties": {
          "description": {
            "type": "string",
            "description": "Contains the seller specified policy and policy terms. Note: Always supply this field. If this field is not specified, any previous value is removed. Call the getCustomPolicy method to return the present field value for this policy. Max length: 15,000",
            "maxLength": 262144
          },
          "label": {
            "type": "string",
            "description": "Customer-facing label shown on View Item pages for items to which the policy applies. This seller-defined string is displayed as a system-generated hyperlink pointing to seller specified policy information. Note: Always supply this field. If this field is not specified, any previous value is removed. Call the getCustomPolicy method to return the present field value for this policy. Max length: 65",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "The seller-defined name for the custom policy. Names must be unique for policies assigned to the same seller and policy type. Note: This field is visible only to the seller. Note: Always supply this field. If this field is not specified, any previous value is removed. Call the getCustomPolicy method to return the present field value for this policy. Max length: 65",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__FulfillmentPolicyRequest": {
        "type": "object",
        "description": "This root container defines a seller's fulfillment policy for a specific marketplace and category group. This type is used when creating or updating a fulfillment business policy.",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "description": "This container is used to specify whether the fulfillment business policy applies to motor vehicle listings, or if it applies to non-motor vehicle listings.",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            },
            "maxItems": 10
          },
          "description": {
            "type": "string",
            "description": "A seller-defined description of the fulfillment policy. This description is only for the seller's use, and is not exposed on any eBay pages. Max length : 250",
            "maxLength": 262144
          },
          "freightShipping": {
            "type": "boolean",
            "description": "This field is included and set to true if freight shipping is available for the item. Freight shipping can be used for large items over 150 lbs. Default : false"
          },
          "globalShipping": {
            "type": "boolean",
            "description": "Note : This field is only applicable for the eBay United Kingdom marketplace ( EBAY_GB ). This field is included and set to true if the seller wants to use the Global Shipping Program for international shipments. See the Global Shipping Program help topic for more details and requirements on the Global Shipping Program. A seller can use a combination of the Global Shipping Program and other international shipping services. If set to false or if the field is omitted, the seller has to manually specifying individual international shipping services (if the seller ships internationally), as described in Setting up worldwide shipping . Sellers opt in or out of the Global Shipping Program through the Shipping preferences in My eBay. eBay International Shipping is an account level setting; no field needs to be set in a Fulfillment business policy to enable eBay International Shipping. If a US seller's account is opted in to eBay International Shipping, this shipping option will be enabled automatically for all listings where international shipping is available. A US seller who is opted in to eBay International Shipping can also specify individual international shipping service options for a Fulfillment business policy. Default : false"
          },
          "handlingTime": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "localPickup": {
            "type": "boolean",
            "description": "This field should be included and set to true if local pickup is one of the fulfillment options available to the buyer. It is possible for the seller to make local pickup and some shipping service options available to the buyer. With local pickup, the buyer and seller make arrangements for pickup time and location. Default : false"
          },
          "marketplaceId": {
            "type": "string",
            "description": "The ID of the eBay marketplace to which this fulfillment policy applies. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "A seller-defined name for this fulfillment policy. Names must be unique for policies assigned to the same marketplace. Max length : 64",
            "maxLength": 262144
          },
          "pickupDropOff": {
            "type": "boolean",
            "description": "This field should be included and set to true if the seller offers the \"Click and Collect\" feature for an item. To enable \"Click and Collect\" on a listing, a seller must be eligible for Click and Collect. Currently, Click and Collect is available to only large retail merchants selling in the eBay AU, UK, DE, FR, and IT marketplaces. In addition to setting this field to true , the merchant must also do the following to enable the \"Click and Collect\" option on a listing: Have inventory for the product at one or more physical stores tied to the merchant's account. Sellers can use the createInventoryLocation method in the Inventory API to associate physical stores to their account and they can then add inventory to specific store locations. Set an immediate payment requirement on the item. The immediate payment feature requires the seller to: Set the immediatePay flag in the payment policy to 'true'. Have a valid store location with a complete street address. When a merchant successfully lists an item with Click and Collect, prospective buyers within a reasonable distance from one of the merchant's stores (that has stock available) will see the \"Available for Click and Collect\" option on the listing, along with information on the closest store that has the item. Default : false"
          },
          "shippingOptions": {
            "type": "array",
            "description": "This array is used to provide detailed information on the domestic and international shipping options available for the policy. A separate ShippingOption object is required for domestic shipping service options and for international shipping service options (if the seller ships to international locations). The optionType field is used to indicate whether the ShippingOption object applies to domestic or international shipping, and the costType field is used to indicate whether flat-rate shipping or calculated shipping will be used. The rateTableId field can be used to associate a defined shipping rate table to the policy, and the packageHandlingCost container can be used to set a handling charge for the policy. A separate ShippingServices object will be used to specify cost and other details for every available domestic and international shipping service option.",
            "items": {
              "$ref": "#/$defs/account__ShippingOption"
            },
            "maxItems": 10
          },
          "shipToLocations": {
            "$ref": "#/$defs/account__RegionSet"
          }
        },
        "additionalProperties": false
      },
      "account__CategoryType": {
        "type": "object",
        "description": "The category type discerns whether the policy applies to motor vehicle listings, or to any other items except motor vehicle listings. Each business policy can be associated with either or both categories ('MOTORS_VEHICLES' and 'ALL_EXCLUDING_MOTORS_VEHICLES'); however, return business policies are not applicable for motor vehicle listings.",
        "properties": {
          "default": {
            "type": "boolean",
            "description": "Note: This field has been deprecated and is no longer used. Do not include this field in any create or update method. This field may be returned within the payload of a get method, but it can be ignored."
          },
          "name": {
            "type": "string",
            "description": "The category type to which the policy applies (motor vehicles or non-motor vehicles). Note: The MOTORS_VEHICLES category type is not valid for return policies. eBay flows do not support the return of motor vehicles. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__TimeDuration": {
        "type": "object",
        "description": "A type used to specify a period of time using a specified time-measurement unit. Payment, return, and fulfillment business policies all use this type to specify time windows. Whenever a container that uses this type is used in a request, both of these fields are required. Similarly, whenever a container that uses this type is returned in a response, both of these fields are always returned.",
        "properties": {
          "unit": {
            "type": "string",
            "description": "These enum values represent the time measurement unit, such as DAY . A span of time is defined when you apply the value specified in the value field to the value specified for unit . See TimeDurationUnitEnum for a complete list of possible time-measurement units. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "value": {
            "type": "integer",
            "description": "An integer that represents an amount of time, as measured by the time-measurement unit specified in the unit field.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "account__ShippingOption": {
        "type": "object",
        "description": "This type is used by the shippingOptions array, which is used to provide detailed information on the domestic and international shipping options available for the policy. A separate ShippingOption object covers domestic shipping service options and international shipping service options (if the seller ships to international locations).",
        "properties": {
          "costType": {
            "type": "string",
            "description": "This field defines whether the shipping cost model is FLAT_RATE (the same rate for all buyers, or buyers within a region if shipping rate tables are used) or CALCULATED (the shipping rate varies by the ship-to location and size and weight of the package). This field is conditionally required if any shipping service options are specified (domestic and/or international). For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "insuranceFee": {
            "$ref": "#/$defs/account__Amount"
          },
          "insuranceOffered": {
            "type": "boolean",
            "description": "This field has been deprecated. Shipping insurance is offered only via a shipping carrier's shipping services and is no longer available via eBay shipping policies."
          },
          "optionType": {
            "type": "string",
            "description": "This field is used to indicate if the corresponding shipping service options (under shippingServices array) are domestic or international shipping service options. This field is conditionally required if any shipping service options are specified (domestic and/or international). For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "packageHandlingCost": {
            "$ref": "#/$defs/account__Amount"
          },
          "rateTableId": {
            "type": "string",
            "description": "This field is used if the seller wants to associate a domestic or international shipping rate table to the fulfillment business policy. The getRateTables method can be used to retrieve shipping rate table IDs. With domestic and international shipping rate tables, the seller can set different shipping costs based on shipping regions and shipping speed/level of service (one-day, expedited, standard, economy). There are also options to add additional per-weight and handling charges. Sellers need to be careful that shipping rate tables match the corresponding shipping service options. In other words, a domestic shipping rate table must not be specified in the same container where international shipping service options are being specified, and vice versa, and the shipping speed/level of service of the provided shipping service options should match the shipping speed/level of service options that are defined in the shipping rate tables. For example, if the corresponding shipping rate table defines costs for one-day shipping services, there should be at least one one-day shipping service option specified under the shippingServices array. This field is returned if set.",
            "maxLength": 262144
          },
          "shippingDiscountProfileId": {
            "type": "string",
            "description": "This field is the unique identifier of a seller's domestic or international shipping discount profile. If a buyer satisfies the requirements of the discount rule, this buyer will receive a shipping discount for the order. The seller can create and manage shipping discount profiles using (Get/Set) ShippingDiscountProfiles calls in the Trading API or through the Shipping Preferences in My eBay .",
            "maxLength": 262144
          },
          "shippingPromotionOffered": {
            "type": "boolean",
            "description": "This boolean indicates whether or not the seller has set up a promotional shipping discount that will be available to buyers who satisfy the requirements of the shipping discount rule. The seller can create and manage shipping promotional discounts using (Get/Set) ShippingDiscountProfiles calls in the Trading API or through the Shipping Preferences in My eBay ."
          },
          "shippingServices": {
            "type": "array",
            "description": "This array consists of the domestic or international shipping services options that are defined for the policy. The shipping service options defined under this array should match what is set in the corresponding shippingOptions.optionType field (which controls whether domestic or international shipping service options are being defined). If a shipping rate table is being used, the specified shipping service options should also match the shipping rate table settings (domestic or international, shipping speed/level of service, etc.) Sellers can specify up to four domestic shipping services and up to five international shipping service options by using separate shippingService containers for each. If the seller is using the Global Shipping Program as an international option, only a total of four international shipping service options (including GSP) can be offered. See How to set up shipping carrier and shipping service values . To use the eBay standard envelope service (eSE), see Using eBay standard envelope (eSE) service . This array is conditionally required if the seller is offering one or more domestic and/or international shipping service options.",
            "items": {
              "$ref": "#/$defs/account__ShippingService"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "account__Amount": {
        "type": "object",
        "description": "A complex type that describes the value of a monetary amount as represented by a global currency. When passing in an amount in a request payload, both currency and value fields are required, and both fields are also always returned for an amount in a response field.",
        "properties": {
          "currency": {
            "type": "string",
            "description": "The base currency applied to the value field to establish a monetary amount. The currency is represented as a 3-letter ISO 4217 currency code. For example, the code for the Canadian Dollar is CAD . Default: The default currency of the eBay marketplace that hosts the listing. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "value": {
            "type": "string",
            "description": "The monetary amount in the specified currency .",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__ShippingService": {
        "type": "object",
        "description": "This type is used by the shippingServices array, an array that provides details about every domestic and international shipping service option that is defined for the policy.",
        "properties": {
          "additionalShippingCost": {
            "$ref": "#/$defs/account__Amount"
          },
          "buyerResponsibleForPickup": {
            "type": "boolean",
            "description": "This field should be included and set to true for a motor vehicle listing if it will be the buyer's responsibility to pick up the purchased motor vehicle after full payment is made. This field is only applicable to motor vehicle listings. In the majority of motor vehicle listings, the seller does make the buyer responsible for pickup or shipment of the vehicle. This field is returned if set. Default : false"
          },
          "buyerResponsibleForShipping": {
            "type": "boolean",
            "description": "This field should be included and set to true for a motor vehicle listing if it will be the buyer's responsibility to arrange for shipment of a motor vehicle. This field is only applicable to motor vehicle listings. In the majority of motor vehicle listings, the seller does make the buyer responsible for pickup or shipment of the vehicle. This field is returned if set. Default : false"
          },
          "freeShipping": {
            "type": "boolean",
            "description": "This field is included and set to true if the seller offers a free domestic shipping option to the buyer. This field can only be included and set to true for the first domestic shipping service option specified in the shippingServices array (it is ignored if set for subsequent shipping services or for any international shipping service option). The first specified shipping service option has a sortOrder value of 1 or if the sortOrderId field is not used, it is the shipping service option that's specified first in the shippingServices array. This container is returned if set."
          },
          "shippingCarrierCode": {
            "type": "string",
            "description": "This field sets/indicates the shipping carrier, such as USPS , FedEx , or UPS . Although this field uses the string type, the seller must pass in a pre-defined enumeration value here. For a full list of shipping carrier enum values for a specified eBay marketplace, the GeteBayDetails call of the Trading API can be used, and the DetailName field's value should be set to ShippingCarrierDetails . The enum values for each shipping carriers can be found in each ShippingCarrierDetails.ShippingCarrier field in the response payload. This field is actually optional, as the shipping carrier is also tied into the shippingServiceCode enum value, and that field is required for every specified shipping service option. This field is returned if set.",
            "maxLength": 262144
          },
          "shippingCost": {
            "$ref": "#/$defs/account__Amount"
          },
          "shippingServiceCode": {
            "type": "string",
            "description": "This field sets/indicates the domestic or international shipping service option, such as USPSPriority , FedEx2Day , or UPS3rdDay . Although this field uses the string type, the seller must pass in a pre-defined enumeration value here. For a full list of shipping service option enum values for a specified eBay marketplace, the GeteBayDetails call of the Trading API can be used, and the DetailName field's value should be set to ShippingServiceDetails . The enum values for each shipping service option can be found in each ShippingServiceDetails.ShippingService field in the response payload. The seller must make sure that the shipping service option is still valid, which is indicated by a true value in the corresponding ValidForSellingFlow boolean field. International shipping service options are typically returned at the top of the response payload, and are indicated by an InternationalService boolean field that reads true . The InternationalService boolean field is not returned at all for domestic shipping service options. This field is required for every specified shipping service option.",
            "maxLength": 262144
          },
          "shipToLocations": {
            "$ref": "#/$defs/account__RegionSet"
          },
          "sortOrder": {
            "type": "integer",
            "description": "The integer value set in this field controls the order of the corresponding domestic or international shipping service option in the View Item and Checkout pages. If the sortOrder field is not supplied, the order of domestic and international shipping service options is determined by the order in which they are listed in the API call. Min : 1. Max : 4 (for domestic shipping service) or 5 (for international shipping service).",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "surcharge": {
            "$ref": "#/$defs/account__Amount"
          }
        },
        "additionalProperties": false
      },
      "account__RegionSet": {
        "type": "object",
        "description": "This type consists of the regionIncluded and regionExcluded arrays, which indicate the areas to where the seller does and doesn't ship.",
        "properties": {
          "regionExcluded": {
            "type": "array",
            "description": "An array of one or more regionName values that specify the areas to where a seller does not ship. A regionExcluded list should only be set in the top-level shipToLocations container and not within the shippingServices.shipToLocations container used to specify which shipping regions are serviced by each available shipping service option. Many sellers are willing to ship to many international locations, but they may want to exclude some world regions or some countries as places they are willing to ship to. This array will be returned as empty if no shipping regions are excluded with the fulfillment business policy. Note: The regionExcluded array is not applicable for motor vehicle business policies on the US, CA, or UK marketplaces. If this array is used in a createFulfillmentPolicy or updateFulfillmentPolicy request, it will be ignored.",
            "items": {
              "$ref": "#/$defs/account__Region"
            },
            "maxItems": 10
          },
          "regionIncluded": {
            "type": "array",
            "description": "An array of one or more regionName fields that specify the areas to where a seller ships. Each eBay marketplace supports its own set of allowable shipping locations. Note: The regionIncluded array is not applicable for motor vehicle business policies on the US, CA, or UK marketplaces. If this array is used in a createFulfillmentPolicy or updateFulfillmentPolicy request, it will be ignored.",
            "items": {
              "$ref": "#/$defs/account__Region"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "account__Region": {
        "type": "object",
        "description": "This type is used to define specific shipping regions. There are four 'levels' of shipping regions, including large geographical regions (like 'Asia', 'Europe', or 'Middle East'), individual countries, US states or Canadian provinces, and special locations/domestic regions within a country (like 'Alaska/Hawaii' or 'PO Box').",
        "properties": {
          "regionName": {
            "type": "string",
            "description": "A string that indicates the name of a region, as defined by eBay. A \"region\" can be either a 'world region' (e.g., the \"Middle East\" or \"Southeast Asia\"), a country (represented with a two-letter country code), a state or province (represented with a two-letter code), or a special domestic region within a country. The GeteBayDetails call in the Trading API can be used to retrieve the world regions and special domestic regions within a specific country. To get these enumeration values, call GeteBayDetails with the DetailName value set to ExcludeShippingLocationDetails .",
            "maxLength": 262144
          },
          "regionType": {
            "type": "string",
            "description": "Reserved for future use. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__PaymentPolicyRequest": {
        "type": "object",
        "description": "This root container defines a seller's payment business policy for a specific marketplace and category group. This type is used when creating or updating a payment business policy.",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "description": "This container is used to specify whether the payment business policy applies to motor vehicle listings, or if it applies to non-motor vehicle listings.",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            },
            "maxItems": 10
          },
          "deposit": {
            "$ref": "#/$defs/account__Deposit"
          },
          "description": {
            "type": "string",
            "description": "A seller-defined description of the payment business policy. This description is only for the seller's use, and is not exposed on any eBay pages. Max length : 250",
            "maxLength": 262144
          },
          "fullPaymentDueIn": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "immediatePay": {
            "type": "boolean",
            "description": "This field should be included and set to true if the seller wants to require immediate payment from the buyer for: A fixed-price item An auction item where the buyer is using the 'Buy it Now' option A deposit for a motor vehicle listing Default: False"
          },
          "marketplaceId": {
            "type": "string",
            "description": "The ID of the eBay marketplace to which this payment business policy applies. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "A seller-defined name for this payment business policy. Names must be unique for policies assigned to the same marketplace. Max length: 64",
            "maxLength": 262144
          },
          "paymentInstructions": {
            "type": "string",
            "description": "Note: DO NOT USE THIS FIELD. Payment instructions are no longer supported by payment business policies. A free-form string field that allows sellers to add detailed payment instructions to their listings.",
            "maxLength": 262144
          },
          "paymentMethods": {
            "type": "array",
            "description": "Note: This field applies only when the seller needs to specify one or more offline payment methods. eBay now manages the electronic payment options available to buyers to pay for the item. This array is used to specify one or more offline payment methods that will be accepted for payment that occurs off of eBay's platform.",
            "items": {
              "$ref": "#/$defs/account__PaymentMethod"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "account__Deposit": {
        "type": "object",
        "description": "This type is used to specify/indicate that an initial deposit is required for a motor vehicle listing.",
        "properties": {
          "amount": {
            "$ref": "#/$defs/account__Amount"
          },
          "dueIn": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "paymentMethods": {
            "type": "array",
            "description": "This array is no longer applicable and should not be used since eBay now manages the electronic payment options available to buyers to pay the deposit.",
            "items": {
              "$ref": "#/$defs/account__PaymentMethod"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "account__PaymentMethod": {
        "type": "object",
        "description": "This type is used by the paymentMethods container, which is used by the seller to specify one or more offline payment methods. Note : eBay now controls all electronic payment methods available for a marketplace, so a seller will no longer use this type to specify any electronic payment methods.",
        "properties": {
          "brands": {
            "type": "array",
            "description": "Note : This array is no longer applicable and should not be used. eBay now controls all electronic payment methods available for a marketplace, and a seller never has to specify any electronic payment methods, including any credit card brands accepted.",
            "items": {
              "type": "string",
              "description": "For implementation help, refer to eBay API documentation",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "paymentMethodType": {
            "type": "string",
            "description": "This array is only applicable for listings supporting offline payment methods. See the PaymentMethodTypeEnum type for supported offline payment method enum values. If offline payments are enabled for the policy, provide at least one offline payment method. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "recipientAccountReference": {
            "$ref": "#/$defs/account__RecipientAccountReference"
          }
        },
        "additionalProperties": false
      },
      "account__RecipientAccountReference": {
        "type": "object",
        "description": "Note : This type is no longer applicable. eBay now controls all electronic payment methods available for a marketplace, and a seller never has to specify any electronic payment methods.",
        "properties": {
          "referenceId": {
            "type": "string",
            "description": "Note : DO NOT USE THIS FIELD. eBay now controls all electronic payment methods available for a marketplace, and a seller never has to specify any electronic payment methods.",
            "maxLength": 262144
          },
          "referenceType": {
            "type": "string",
            "description": "Note : DO NOT USE THIS FIELD. eBay now controls all electronic payment methods available for a marketplace, and a seller never has to specify any electronic payment methods. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__ReturnPolicyRequest": {
        "type": "object",
        "description": "This root container defines a seller's return business policy for a specific marketplace and category group. This type is used when creating or updating a return business policy.",
        "properties": {
          "categoryTypes": {
            "type": "array",
            "description": "This container indicates which category group that the return policy applies to. Note : Return business policies are not applicable to motor vehicle listings, so the categoryTypes.name value must be set to ALL_EXCLUDING_MOTORS_VEHICLES for return business policies.",
            "items": {
              "$ref": "#/$defs/account__CategoryType"
            },
            "maxItems": 10
          },
          "description": {
            "type": "string",
            "description": "A seller-defined description of the return business policy. This description is only for the seller's use, and is not exposed on any eBay pages. Max length : 250",
            "maxLength": 262144
          },
          "extendedHolidayReturnsOffered": {
            "type": "boolean",
            "description": "Important! This field is deprecated, since eBay no longer supports extended holiday returns. Any value supplied in this field is neither read nor returned."
          },
          "internationalOverride": {
            "$ref": "#/$defs/account__InternationalReturnOverrideType"
          },
          "marketplaceId": {
            "type": "string",
            "description": "The ID of the eBay marketplace to which this return business policy applies. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "A seller-defined name for this return business policy. Names must be unique for policies assigned to the same marketplace. Max length : 64",
            "maxLength": 262144
          },
          "refundMethod": {
            "type": "string",
            "description": "This field sets the refund method to use for returned items. Its value defaults to MONEY_BACK if omitted, so this field is only needed for Buy online, Pickup in Store or Click and Collect items where the seller is willing to offer merchandise credit as an additional refund method to buyers. Getting their money back for returned items is always an option for buyers, regardless of what the seller sets in this field. Important! If this field is not included in a return business policy, it will default to MONEY_BACK . For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "restockingFeePercentage": {
            "type": "string",
            "description": "Important! This field is deprecated, since eBay no longer allows sellers to charge a restocking fee for buyer remorse returns. If this field is included, it is ignored.",
            "maxLength": 262144
          },
          "returnInstructions": {
            "type": "string",
            "description": "This text-based field provides more details on seller-specified return instructions. Important! This field is no longer supported on many eBay marketplaces. To see if a marketplace and eBay category does support this field, call getReturnPolicies method of the Metadata API . Then you will look for the policyDescriptionEnabled field with a value of true for the eBay category. Max length : 5000 (8000 for DE)",
            "maxLength": 262144
          },
          "returnMethod": {
            "type": "string",
            "description": "This field can be used if the seller is willing and able to offer a replacement item as an alternative to 'Money Back'. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "returnPeriod": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "returnsAccepted": {
            "type": "boolean",
            "description": "If set to true , the seller accepts returns. If set to false , the seller does not accept returns. Note: Top-Rated sellers must accept item returns and the handlingTime should be set to zero days or one day for a listing to receive a Top-Rated Plus badge on the View Item or search result pages. For more information on eBay's Top-Rated seller program, see Becoming a Top Rated Seller and qualifying for Top Rated Plus benefits ."
          },
          "returnShippingCostPayer": {
            "type": "string",
            "description": "This field indicates who is responsible for paying for the shipping charges for returned items. The field can be set to either BUYER or SELLER . Note: Eligible Parts & Accessories (P&A) listings require sellers to offer buyers free returns with a minimum return period of 30 days. See Support for easy returns in Parts and Accessories for details. Depending on the return policy and specifics of the return, either the buyer or the seller can be responsible for the return shipping costs. Note that the seller is always responsible for return shipping costs for SNAD-related issues. This field is conditionally required if returnsAccepted is set to true . For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__InternationalReturnOverrideType": {
        "type": "object",
        "description": "This type defines the fields for a seller's international return policy. Sellers have the ability to set separate domestic and international return policies, but if an international return policy is not set, the same return policy settings specified for the domestic return policy are also used for returns for international buyers.",
        "properties": {
          "returnMethod": {
            "type": "string",
            "description": "This field sets/indicates if the seller offers replacement items to the buyer in the case of an international return. The buyer must be willing to accept a replacement item; otherwise, the seller will need to issue a refund for a return. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "returnPeriod": {
            "$ref": "#/$defs/account__TimeDuration"
          },
          "returnsAccepted": {
            "type": "boolean",
            "description": "If set to true , the seller accepts international returns. If set to false , the seller does not accept international returns. This field is conditionally required if the seller chooses to have a separate international return policy."
          },
          "returnShippingCostPayer": {
            "type": "string",
            "description": "This field indicates who is responsible for paying for the shipping charges for returned items. The field can be set to either BUYER or SELLER . Depending on the return policy and specifics of the return, either the buyer or the seller can be responsible for the return shipping costs. Note that the seller is always responsible for return shipping costs for 'significantly not as described' (SNAD) issues. This field is conditionally required if the internationalOverride.returnsAccepted field is set to true . For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account__BulkSalesTaxInput": {
        "type": "object",
        "properties": {
          "salesTaxInputList": {
            "type": "array",
            "description": "The array of sales-tax table entries to be created or updated.",
            "items": {
              "$ref": "#/$defs/account__SalesTaxInput"
            },
            "maxItems": 10,
            "minItems": 1
          }
        },
        "additionalProperties": false,
        "required": [
          "salesTaxInputList"
        ]
      },
      "account__SalesTaxInput": {
        "type": "object",
        "properties": {
          "countryCode": {
            "type": "string",
            "description": "This parameter specifies the two-letter ISO 3166 code of the country for which a sales-tax table entry is to be created or updated. Note: Sales-tax tables are available only for the US and Canada marketplaces. Therefore, the only supported values are: US CA",
            "maxLength": 262144
          },
          "salesTaxJurisdictionId": {
            "type": "string",
            "description": "This parameter specifies the ID of the tax jurisdiction for which a sales-tax table entry is to be created or updated. Valid jurisdiction IDs can be retrieved using the getSalesTaxJurisdiction method of the Metadata API. Note: When countryCode is set to US , the only supported values for jurisdictionId are: AS (American Samoa) GU (Guam) MP (Northern Mariana Islands) PW (Palau) VI (US Virgin Islands)",
            "maxLength": 262144
          },
          "salesTaxPercentage": {
            "type": "string",
            "description": "This parameter specifies the sales tax rate for the specified salesTaxJurisdictionId . When applicable to an order, this sales tax rate will be applied to the sales price. The shippingAndHandlingTaxed value indicates whether or not sales tax is also applied to shipping and handling charges Although it is a string, a percentage value is set here, such as 7.75 .",
            "maxLength": 262144
          },
          "shippingAndHandlingTaxed": {
            "type": "boolean",
            "description": "This parameter is set to true if the seller wishes to apply sales tax to shipping and handling charges and not just the total sales price of an order. Otherwise, this parameter's value should be set to false ."
          }
        },
        "additionalProperties": false
      },
      "account__SalesTaxBase": {
        "type": "object",
        "description": "This type is used by the base request of the createOrReplaceSalesTax .",
        "properties": {
          "salesTaxPercentage": {
            "type": "string",
            "description": "This field is used to set the sales tax rate for the tax jurisdiction set in the call URI. When applicable to an order, this sales tax rate will be applied to sales price. The shippingAndHandlingTaxed value will indicate whether or not sales tax is also applied to shipping and handling charges Although it is a string, a percentage value is set here, such as 7.75 .",
            "maxLength": 262144
          },
          "shippingAndHandlingTaxed": {
            "type": "boolean",
            "description": "This field is set to true if the seller wishes to apply sales tax to shipping and handling charges, and not just the total sales price of the order. Otherwise, this field's value should be set to false ."
          }
        },
        "additionalProperties": false
      },
      "account_v2__RateTableUpdate": {
        "type": "object",
        "description": "This type is used by the request payload of the updateShippingCost method to pass updated shipping cost information for a rate table identified by rateTableId .",
        "properties": {
          "rates": {
            "type": "array",
            "description": "An array of rate objects for which shippingCost and/or additionalCost are to be updated.",
            "items": {
              "$ref": "#/$defs/account_v2__RateUpdate"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "account_v2__RateUpdate": {
        "type": "object",
        "description": "This container defines the updated shipping cost information for a rate object identified by rateId . To view a list of all rate objects and corresponding rateID values, issue getRateTable for the rate table identified by rateTableId .",
        "properties": {
          "additionalCost": {
            "$ref": "#/$defs/account_v2__Amount"
          },
          "rateId": {
            "type": "string",
            "description": "The identifier for the rate object. Note: This is a string automatically assigned by the system when the rate object is created. It cannot be changed or updated.",
            "maxLength": 262144
          },
          "shippingCost": {
            "$ref": "#/$defs/account_v2__Amount"
          }
        },
        "additionalProperties": false
      },
      "account_v2__Amount": {
        "type": "object",
        "description": "A complex type that describes the value of a monetary amount as represented by a global currency.",
        "properties": {
          "currency": {
            "type": "string",
            "description": "The base currency applied to the value field to establish a monetary amount. The currency is represented as a 3-letter ISO 4217 currency code. For example, the code for the Canadian Dollar is CAD . For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "value": {
            "type": "string",
            "description": "The monetary amount in the specified currency .",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account_v2__CreateCalculatedShippingRulesRequest": {
        "type": "object",
        "description": "This type defines the structure of a request to create calculated shipping rules, including handling, duration, and rule type details.",
        "properties": {
          "calculatedHandlingRule": {
            "$ref": "#/$defs/account_v2__CalculatedHandlingRuleType"
          },
          "calculatedShippingRule": {
            "$ref": "#/$defs/account_v2__CalculatedShippingRuleType"
          },
          "combinedDuration": {
            "type": "string",
            "description": "This container specifies the time window during which multiple unpaid orders can be combined into a single payment or invoice, represented by using one of the values in CombinedPaymentPeriodEnum type. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account_v2__CalculatedHandlingRuleType": {
        "type": "object",
        "description": "This type defines the structure for calculated handling fee discounts applicable when combining multiple orders.",
        "properties": {
          "combinedShippingRuleType": {
            "type": "string",
            "description": "This enumeration type specifies the type of combined-shipping rule applied to handling fees (for example, weight-based, flat-rate, or percentage-based calculation method). For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "eachAdditionalAmount": {
            "$ref": "#/$defs/account_v2__Amount"
          },
          "eachAdditionalAmountOffShippingCost": {
            "$ref": "#/$defs/account_v2__Amount"
          },
          "eachAdditionalPercentOffShippingCost": {
            "type": "number",
            "description": "This integer specifies the percentage discount applied to the total shipping cost for each additional item in a combined shipment."
          },
          "orderHandlingAmount": {
            "$ref": "#/$defs/account_v2__Amount"
          }
        },
        "additionalProperties": false
      },
      "account_v2__CalculatedShippingRuleType": {
        "type": "object",
        "description": "This type describes calculated discount rules determining total shipping cost reductions for combined items.",
        "properties": {
          "combinedShippingRules": {
            "type": "array",
            "description": "This array lists the discount rules applied to combined shipments, detailing calculation methods and rule identifiers. When used by a create call, there won't be any rule ID.",
            "items": {
              "$ref": "#/$defs/account_v2__CombinedShippingRule"
            },
            "maxItems": 10
          },
          "combinedShippingRuleType": {
            "type": "string",
            "description": "This container defines the type of combined-shipping rule applied to calculate discounts, such as weight-based, percentage-based, or flat-rate models. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account_v2__CombinedShippingRule": {
        "type": "object",
        "description": "This container defines a discount profile schema for combined shipping, including rule IDs, names, and applicable weight or amount reductions. Note: This field is not applicable for the create rule use case.",
        "properties": {
          "combinedShippingRuleId": {
            "type": "string",
            "description": "This field represents the unique identifier for the combined-shipping discount profile, used to reference or update a specific rule configuration.",
            "maxLength": 262144
          },
          "combinedShippingRuleName": {
            "type": "string",
            "description": "This field specifies the unique name identifying the combined shipping discount profile within the seller’s account. This name is configured by the seller and can have a maximum of XX characters.",
            "maxLength": 262144
          },
          "eachAdditionalAmount": {
            "$ref": "#/$defs/account_v2__Amount"
          },
          "eachAdditionalAmountOffShippingCost": {
            "$ref": "#/$defs/account_v2__Amount"
          },
          "eachAdditionalPercentOffShippingCost": {
            "type": "number",
            "description": "This integer specifies the percentage discount applied to the total shipping cost for each additional item in the combined order."
          },
          "mappedCombinedShippingRuleId": {
            "type": "string",
            "description": "This field specifies the unique ID that links this combined-shipping rule to another related rule in the seller’s account.",
            "maxLength": 262144
          },
          "weightOffTotalWeight": {
            "$ref": "#/$defs/account_v2__MeasureType"
          }
        },
        "additionalProperties": false
      },
      "account_v2__MeasureType": {
        "type": "object",
        "description": "This type displays measurement type with value, unit, and measurement system.",
        "properties": {
          "unit": {
            "type": "string",
            "description": "This field defines the unit of measure (e.g., kilograms, pounds) associated with the value field. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "value": {
            "type": "string",
            "description": "This field defines the numeric value representing the measurement, weight, in the specified unit.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account_v2__CreateFlatShippingRulesRequest": {
        "type": "object",
        "description": "This type represents a request to configure flat-rate combined shipping rules with specified durations and conditions.",
        "properties": {
          "combinedDuration": {
            "type": "string",
            "description": "This container specifies the time window during which multiple unpaid orders can be combined into a single payment or invoice, represented by using one of the values in CombinedPaymentPeriodEnum type. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "flatShippingRule": {
            "$ref": "#/$defs/account_v2__FlatShippingRuleType"
          }
        },
        "additionalProperties": false
      },
      "account_v2__FlatShippingRuleType": {
        "type": "object",
        "description": "This type defines the flat-rate combined-shipping rule, which applies a fixed shipping cost for multiple items shipped together.",
        "properties": {
          "combinedShippingRules": {
            "type": "array",
            "description": "This array specifies the type of combined-shipping rule applied, such as flat-rate or cost-based.",
            "items": {
              "$ref": "#/$defs/account_v2__CombinedShippingRule"
            },
            "maxItems": 10
          },
          "combinedShippingRuleType": {
            "type": "string",
            "description": "This container defines the type of discount rule applied (e.g., percentage-based, fixed-rate). For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account_v2__CreatePromotionalShippingRuleRequest": {
        "type": "object",
        "description": "This type represents the request schema for creating promotional shipping rules with combined payment durations.",
        "properties": {
          "combinedDuration": {
            "type": "string",
            "description": "This container specifies the time window during which multiple unpaid orders can be combined into a single payment or invoice, represented by using one of the values in CombinedPaymentPeriodEnum type. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "promotionalShippingRule": {
            "$ref": "#/$defs/account_v2__PromotionalShippingRuleType"
          }
        },
        "additionalProperties": false
      },
      "account_v2__PromotionalShippingRuleType": {
        "type": "object",
        "description": "This type is used to represent a promotional shipping rule set up by the seller on an eBay marketplace.",
        "properties": {
          "combinedShippingRuleType": {
            "type": "string",
            "description": "This field specifies the type of combined-shipping rule applied, such as flat-rate or cost-based, as defined in the CombinedShippingRuleTypeEnum. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "itemCount": {
            "type": "integer",
            "description": "This integer indicates the quantity of items that must be purchased by the buyer in order for that buyer to qualify for the promotional discount.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "orderAmount": {
            "$ref": "#/$defs/account_v2__Amount"
          },
          "shippingCost": {
            "$ref": "#/$defs/account_v2__Amount"
          }
        },
        "additionalProperties": false
      },
      "account_v2__UpdateCalculatedShippingRulesRequest": {
        "type": "object",
        "description": "This type is used to update calculated shipping rules.",
        "properties": {
          "calculatedHandlingRule": {
            "$ref": "#/$defs/account_v2__CalculatedHandlingRuleType"
          },
          "calculatedShippingRule": {
            "$ref": "#/$defs/account_v2__CalculatedShippingRuleType"
          },
          "combinedDuration": {
            "type": "string",
            "description": "This container specifies the duration within which multiple unpaid orders may be combined into a single invoice, represented by one of the values in the CombinedPaymentPeriodEnum type. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account_v2__UpdateCombinedPaymentsRequest": {
        "type": "object",
        "description": "This type is used to update the combined payment duration",
        "properties": {
          "combinedDuration": {
            "type": "string",
            "description": "This field specifies the duration within which multiple unpaid orders may be combined into a single invoice. One of the values in the CombinedPaymentPeriodEnum type must be used in this field. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "account_v2__UpdateFlatShippingRulesRequest": {
        "type": "object",
        "description": "This type defines a request to update flat shipping rules.",
        "properties": {
          "combinedDuration": {
            "type": "string",
            "description": "This field specifies the duration within which multiple unpaid orders may be combined into a single invoice. One of the values in the CombinedPaymentPeriodEnum type must be used in this field. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "flatShippingRule": {
            "$ref": "#/$defs/account_v2__FlatShippingRuleType"
          }
        },
        "additionalProperties": false
      },
      "account_v2__UpdatePromotionalShippingRuleRequest": {
        "type": "object",
        "description": "This type defines a request to update promotional shipping rule.",
        "properties": {
          "combinedDuration": {
            "type": "string",
            "description": "This container specifies the duration within which multiple unpaid orders may be combined into a single invoice. One of the values in the CombinedPaymentPeriodEnum type must be used in this field. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "promotionalShippingRule": {
            "$ref": "#/$defs/account_v2__PromotionalShippingRuleType"
          }
        },
        "additionalProperties": false
      },
      "inventory__BulkInventoryItem": {
        "type": "object",
        "description": "The base request of the bulkCreateOrReplaceInventoryItem method.",
        "properties": {
          "requests": {
            "type": "array",
            "description": "The details of each inventory item that is being created or updated is passed in under this container. Up to 25 inventory item records can be created and/or updated with one bulkCreateOrReplaceInventoryItem call.",
            "items": {
              "$ref": "#/$defs/inventory__InventoryItemWithSkuLocale"
            },
            "maxItems": 10,
            "minItems": 1
          }
        },
        "additionalProperties": false,
        "required": [
          "requests"
        ]
      },
      "inventory__InventoryItemWithSkuLocale": {
        "type": "object",
        "description": "This type is used to define/modify each inventory item record that is being created and/or updated with the bulkCreateOrReplaceInventoryItem method. Up to 25 inventory item records can be created and/or updated with one call.",
        "properties": {
          "availability": {
            "$ref": "#/$defs/inventory__Availability"
          },
          "condition": {
            "type": "string",
            "description": "This enumeration value indicates the condition of the item. Supported item condition values will vary by eBay site and category. To see which item condition values that a particular eBay category supports, use the getItemConditionPolicies method of the Metadata API . This method returns condition ID values that map to the enumeration values defined in the ConditionEnum type. The Item condition ID and name values topic in the Selling Integration Guide has a table that maps condition ID values to ConditionEnum values. The getItemConditionPolicies call reference page has more information. A condition value is optional up until the seller is ready to publish an offer with the SKU, at which time it becomes required for most eBay categories. Important! Publish offer note: This field is required before an offer can be published to create an active listing. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "conditionDescription": {
            "type": "string",
            "description": "This string field is used by the seller to more clearly describe the condition of a used inventory item, or an inventory item whose condition value is not NEW , LIKE_NEW , NEW_OTHER , or NEW_WITH_DEFECTS . The conditionDescription field is available for all eBay categories. If the conditionDescription field is used with an item in one of the new conditions (mentioned in previous paragraph), eBay will simply ignore this field if included, and eBay will return a warning message to the user. This field should only be used to further clarify the condition of the used item. It should not be used for branding, promotions, shipping, returns, payment or other information unrelated to the condition of the used item. Make sure that the condition value, condition description, listing description, and the item's pictures do not contradict one another. This field is not always required, but is required if an inventory item is being updated and a condition description already exists for that inventory item. This field is returned in the getInventoryItem , bulkGetInventoryItem , and getInventoryItems calls if a condition description was provided for a used inventory item. Max Length : 1000",
            "maxLength": 262144
          },
          "conditionDescriptors": {
            "type": "array",
            "description": "This container is used by the seller to provide additional information about the condition of an item in a structured format. Condition descriptors are name-value attributes that can be either closed set or open text inputs. For trading card and coin listings in applicable categories, sellers must use either LIKE_NEW (2750) or USED_VERY_GOOD (4000) item condition to specify the item as Graded or Ungraded , respectively. Use of either of these conditions requires the seller to use this array to provide one or more applicable Condition Descriptor name-value pairs. To retrieve all condition descriptor numeric IDs for a category, use the getItemConditionPolicies method of the Metadata API.",
            "items": {
              "$ref": "#/$defs/inventory__ConditionDescriptor"
            },
            "maxItems": 10
          },
          "locale": {
            "type": "string",
            "description": "This request parameter sets the natural language that was provided in the field values of the request payload (i.e., en_AU, en_GB or de_DE). For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "packageWeightAndSize": {
            "$ref": "#/$defs/inventory__PackageWeightAndSize"
          },
          "product": {
            "$ref": "#/$defs/inventory__Product"
          },
          "sku": {
            "type": "string",
            "description": "This is the seller-defined SKU value of the product that will be listed on the eBay site (specified in the marketplaceId field). Only one offer (in unpublished or published state) may exist for each sku / marketplaceId / format combination. This field is required. Max Length : 50",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__Availability": {
        "type": "object",
        "description": "This type is used to specify the quantity of the inventory item that is available for purchase if the item will be shipped to the buyer, and the quantity of the inventory item that is available for In-Store Pickup at one or more of the merchant's physical stores. In-Store Pickup is only available to large merchants selling on the US, UK, Germany, and Australia sites.",
        "properties": {
          "pickupAtLocationAvailability": {
            "type": "array",
            "description": "This container consists of an array of one or more of the merchant's physical store locations where the inventory item is available for In-Store Pickup orders. The merchant's location, the quantity available, and the fulfillment time (how soon the item will be ready for pickup after the order takes place) are all in this container. In-Store Pickup is only available to large merchants selling on the US, UK, Germany, and Australia sites.",
            "items": {
              "$ref": "#/$defs/inventory__PickupAtLocationAvailability"
            },
            "maxItems": 10
          },
          "shipToLocationAvailability": {
            "$ref": "#/$defs/inventory__ShipToLocationAvailability"
          }
        },
        "additionalProperties": false
      },
      "inventory__PickupAtLocationAvailability": {
        "type": "object",
        "description": "This type is used to specify/indicate the quantity of the inventory item that is available for an In-Store Pickup order at the merchant's physical store (specified by the merchantLocationKey field).",
        "properties": {
          "availabilityType": {
            "type": "string",
            "description": "The enumeration value in this field indicates the availability status of the inventory item at the merchant's physical store specified by the pickupAtLocationAvailability.merchantLocationKey field. This field is required if the pickupAtLocationAvailability container is used, and is always returned with the pickupAtLocationAvailability container. See AvailabilityTypeEnum for more information about how/when you use each enumeration value. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "fulfillmentTime": {
            "$ref": "#/$defs/inventory__TimeDuration"
          },
          "merchantLocationKey": {
            "type": "string",
            "description": "The unique identifier of a merchant's store where the In-Store Pickup inventory item is currently located, or where inventory will be sent to. If the merchant's store is currently awaiting for inventory, the availabilityType value should be SHIP_TO_STORE . This field is required if the pickupAtLocationAvailability container is used, and is always returned with the pickupAtLocationAvailability container. Use the getInventoryLocations method to retrieve merchant location keys. Max length : 36",
            "maxLength": 262144
          },
          "quantity": {
            "type": "integer",
            "description": "This integer value indicates the quantity of the inventory item that is available for In-Store Pickup at the store identified by the merchantLocationKey value. The value of quantity should be an integer value greater than 0 , unless the inventory item is out of stock. This field is required if the pickupAtLocationAvailability container is used, and is always returned with the pickupAtLocationAvailability container.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "inventory__TimeDuration": {
        "type": "object",
        "description": "This type is used to indicate the fulfillment time for an In-Store Pickup order, or for an order than will be shipped to the buyer.",
        "properties": {
          "unit": {
            "type": "string",
            "description": "This enumeration value indicates the time unit used to specify the fulfillment time, such as BUSINESS_DAY . For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "value": {
            "type": "integer",
            "description": "The integer value in this field, along with the time unit in the unit field, will indicate the fulfillment time. For standard orders that will be shipped, this value will indicate the expected fulfillment time if the inventory item is shipped from the inventory location. If the value of this field is 4 , and the value of the unit field is BUSINESS_DAY , then the estimated delivery date after purchase is 4 business days.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "inventory__ShipToLocationAvailability": {
        "type": "object",
        "description": "This type is used to specify the total 'ship-to-home' quantity of the inventory item that will be available for purchase through one or more published offers.",
        "properties": {
          "availabilityDistributions": {
            "type": "array",
            "description": "This container is used to set the available quantity of the inventory item at one or more warehouse locations. This container will be returned if available quantity is set for one or more inventory locations.",
            "items": {
              "$ref": "#/$defs/inventory__AvailabilityDistribution"
            },
            "maxItems": 10
          },
          "quantity": {
            "type": "integer",
            "description": "This container is used to set the total 'ship-to-home' quantity of the inventory item that will be available for purchase through one or more published offers. This field represents the total quantity of the item that is available for sale across all marketplaces. To update the available quantity allocated to a specific marketplace, use the availableQuantity field in the offer container associated with that marketplace. Note: To ensure that the available quantity allocated to a specific marketplace doesn't exceed the total available stock, the quantity specified on a listing will be the minimum value between this field and the availableQuantity field. If an existing inventory item is being updated, and the 'ship-to-home' quantity already exists for the inventory item record, this field should be included again, even if the value is not changing, or the available quantity data will be lost. Important! This field is not immediately required, but 'ship-to-home' quantity must be set before an offer of the inventory item can be published.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "inventory__AvailabilityDistribution": {
        "type": "object",
        "description": "This type is used to set the available quantity of the inventory item at one or more warehouse locations.",
        "properties": {
          "fulfillmentTime": {
            "$ref": "#/$defs/inventory__TimeDuration"
          },
          "merchantLocationKey": {
            "type": "string",
            "description": "The unique identifier of an inventory location where quantity is available for the inventory item. This field is conditionally required to identify the inventory location that has quantity of the inventory item. Use the getInventoryLocations method to retrieve merchant location keys.",
            "maxLength": 262144
          },
          "quantity": {
            "type": "integer",
            "description": "The integer value passed into this field indicates the quantity of the inventory item that is available at this inventory location. This field is conditionally required.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "inventory__ConditionDescriptor": {
        "type": "object",
        "description": "This type is used by the seller to provide additional information about the condition of an item in a structured format.",
        "properties": {
          "additionalInfo": {
            "type": "string",
            "description": "This string provides additional information about a condition descriptor. Open text is passed in this field. In the case of trading cards and coins, this field houses the optional Certification Number condition descriptor for graded items. Max Length: 30 characters",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "This string provides the name of a condition descriptor. A numeric ID is passed in this field. This numeric ID maps to the name of a condition descriptor. Condition descriptor name-value pairs provide more information about an item's condition in a structured way. To retrieve all condition descriptor name numeric IDs for a category, refer to the conditionDescriptorId field returned in the getItemConditionPolicies method of Metadata API. In the case of trading cards, this field is used to provide condition descriptors for a card. For graded cards, the condition descriptors for Grader and Grade are required, while the condition descriptor for Certification Number is optional. For ungraded cards, only the Card Condition condition descriptor is required. In the case of coins, this field is used to provide condition descriptors for a coin. For graded coins, the condition descriptors for Grader , Number Grade , and Letter Grade are required, while the condition descriptor for Certification Number is optional. For ungraded coins, only the Coin Condition condition descriptor is required.",
            "maxLength": 262144
          },
          "values": {
            "type": "array",
            "description": "This array provides the value(s) associated with a condition descriptor. One or more numeric IDs is passed in this field. Commas are used as delimiters between successive name/value pairs. These numeric IDs map to the values associated with a condition descriptor name. Condition descriptor name-value pairs provide more information about an item's condition in a structured way. To retrieve all condition descriptor value numeric IDs for a category, refer to the ConditionDescriptorValueId array returned in the getItemConditionPolicies method of Metadata API. In the case of trading cards, this field houses the information on the Grader and Grade descriptors of graded cards and the Card Condition descriptor for ungraded cards. In the case of coins, this field houses the information on the Grader and Number Grade , and Letter Grade descriptors of graded coins and the Coin Condition descriptor for ungraded coins.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__PackageWeightAndSize": {
        "type": "object",
        "description": "This type is used to indicate the package type, weight, and dimensions of the shipping package. Package weight and dimensions are required when calculated shipping rates are used, and weight alone is required when flat-rate shipping is used, but with a weight surcharge. See the Calculated shipping help page for more information on calculated shipping.",
        "properties": {
          "dimensions": {
            "$ref": "#/$defs/inventory__Dimension"
          },
          "packageType": {
            "type": "string",
            "description": "This enumeration value indicates the type of shipping package used to ship the inventory item. The supported values for this field can be found in the PackageTypeEnum type. This field will be returned if the package type is set for the inventory item. Note: You can use the GeteBayDetails Trading API call to retrieve a list of supported package types for a specific marketplace. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "shippingIrregular": {
            "type": "boolean",
            "description": "A value of true indicates that the package is irregular and cannot go through the stamping machine at the shipping service office. This field applies to calculated shipping only. Irregular packages require special or fragile handling."
          },
          "weight": {
            "$ref": "#/$defs/inventory__Weight"
          }
        },
        "additionalProperties": false
      },
      "inventory__Dimension": {
        "type": "object",
        "description": "This type is used to specify the dimensions (and the unit used to measure those dimensions) of a shipping package. The dimensions container is conditionally required if the seller will be offering calculated shipping rates to determine shipping cost. See the Calculated shipping help page for more information on calculated shipping.",
        "properties": {
          "height": {
            "type": "number",
            "description": "The actual height (in the measurement unit specified in the unit field) of the shipping package. All fields of the dimensions container are required if package dimensions are specified. If a shipping package measured 21.5 inches in length, 15.0 inches in width, and 12.0 inches in height, the dimensions container would look as follows: \"dimensions\": { \"length\": 21.5, \"width\": 15.0, \"height\": 12.0, \"unit\": \"INCH\" }"
          },
          "length": {
            "type": "number",
            "description": "The actual length (in the measurement unit specified in the unit field) of the shipping package. All fields of the dimensions container are required if package dimensions are specified. If a shipping package measured 21.5 inches in length, 15.0 inches in width, and 12.0 inches in height, the dimensions container would look as follows: \"dimensions\": { \"length\": 21.5, \"width\": 15.0, \"height\": 12.0, \"unit\": \"INCH\" }"
          },
          "unit": {
            "type": "string",
            "description": "The unit of measurement used to specify the dimensions of a shipping package. All fields of the dimensions container are required if package dimensions are specified. If the English system of measurement is being used, the applicable values for dimension units are FEET and INCH . If the metric system of measurement is being used, the applicable values for weight units are METER and CENTIMETER . The metric system is used by most countries outside of the US. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "width": {
            "type": "number",
            "description": "The actual width (in the measurement unit specified in the unit field) of the shipping package. All fields of the dimensions container are required if package dimensions are specified. If a shipping package measured 21.5 inches in length, 15.0 inches in width, and 12.0 inches in height, the dimensions container would look as follows: \"dimensions\": { \"length\": 21.5, \"width\": 15.0, \"height\": 12.0, \"unit\": \"INCH\" }"
          }
        },
        "additionalProperties": false
      },
      "inventory__Weight": {
        "type": "object",
        "description": "This type is used to specify the weight (and the unit used to measure that weight) of a shipping package. The weight container is conditionally required if the seller will be offering calculated shipping rates to determine shipping cost, or is using flat-rate costs, but charging a weight surcharge. See the Calculated shipping help page for more information on calculated shipping.",
        "properties": {
          "unit": {
            "type": "string",
            "description": "The unit of measurement used to specify the weight of a shipping package. Both the unit and value fields are required if the weight container is used. If the English system of measurement is being used, the applicable values for weight units are POUND and OUNCE . If the metric system of measurement is being used, the applicable values for weight units are KILOGRAM and GRAM . The metric system is used by most countries outside of the US. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "value": {
            "type": "number",
            "description": "The actual weight (in the measurement unit specified in the unit field) of the shipping package. Both the unit and value fields are required if the weight container is used. If a shipping package weighed 20.5 ounces, the container would look as follows: \"weight\": { \"value\": 20.5, \"unit\": \"OUNCE\" }"
          }
        },
        "additionalProperties": false
      },
      "inventory__Product": {
        "type": "object",
        "description": "This type is used to define the product details, such as a title, a product description, product aspects/item specifics, and links to images for the product. Optionally, in a createOrReplaceInventoryItem call, a seller can pass in an eBay Product Identifier (ePID) or a Global Trade Item Number (GTIN) value, such as an EAN, an ISBN, a UPC, to identify a product to be matched with a product in the eBay Catalog. The information in this type is also returned in the getInventoryItem , getInventoryItems , and bulkGetInventoryItem calls if defined.",
        "properties": {
          "aspects": {
            "type": "object",
            "description": "This is a collection of item specifics (aka product aspects) name-value pairs that provide more information about the product and might make it easier for buyers to find. To view required/recommended product aspects/item specifics names (and corresponding values) for a specific eBay category, sellers can use the getItemAspectsForCategory method of the Taxonomy API. Alternatively, sellers can view similar items on eBay.com in the same category to get an idea of what other sellers are using for product aspects/item specifics. Important! Effective from December 28th, 2024, sellers offering certain rechargeable devices in EU and Northern Ireland markets must comply with the Common Charger Directive (CCD) and list appropriate charger-related aspects and values on their listings. See Common Charger Directive for more information. Sellers also have the option of specifying an eBay Product ID (ePID) or optionally, a Global Trade Item Number (GTIN) through the corresponding fields in the product container in an attempt to find a product match in the eBay Catalog. If a match is found based on the ePID or GTIN value, the product aspects that are defined for the eBay Catalog product will automatically get picked up by the newly created/updated inventory item. Below is an example of the proper JSON syntax to use when manually inputting item specifics. Note that one item specific name, such as 'Features', can have more than one value. If an item specific name has more than one value, each value is delimited with a comma. \"aspects\": { \"Brand\": [\"GoPro\"], \"Storage Type\": [\"Removable\"] } Note that inventory items that will become part of an inventory item group and multiple-variation listing should have the same attributes that are defined for the inventory item group. This container will be returned if one or more item specific pairs are defined for the inventory item. Important! Publish offer note: This field is required before an offer can be published to create an active listing. Max Length for Aspect Name : 40 Max Length for Aspect Value : 50",
            "additionalProperties": {
              "type": "array",
              "items": {
                "type": "string",
                "maxLength": 50
              },
              "maxItems": 10
            }
          },
          "brand": {
            "type": "string",
            "description": "The brand of the product. This field is often paired with the mpn field to identify a specific product by Manufacturer Part Number. This field is conditionally required if the eBay category requires a Manufacturer Part Number (MPN) value. If eBay is able to find a product match in the eBay Catalog when an eBay Product ID (ePID) or GTIN value (UPC, ISBN, or EAN) is supplied, all product details of that eBay Catalog product is picked up by the inventory item record (including brand) if the createOrReplaceInventoryItem call is successful. This field is returned if defined for an inventory item. If a brand was passed in as an item specific name-value pair through the aspects array in a createOrReplaceInventoryItem call, this value is also picked up by the brand field. Max Length : 65",
            "maxLength": 262144
          },
          "description": {
            "type": "string",
            "description": "The description of the product. The description of an existing inventory item can be added or modified with a createOrReplaceInventoryItem call. The description of an inventory item is automatically populated if the seller specifies an eBay Product ID (ePID) or a Global Trade Item Number (GTIN) and eBay is able to find a matching product in the eBay Catalog. Note that this field is optional but recommended. If a listingDescription field is omitted when creating and publishing a single-variation offer, the text in this field will be used instead. If neither the product.description field for the inventory item nor the listingDescription field for the offer exist, the publishOffer call will fail. If the inventory item will be part of an inventory item group/multiple-variation listing, this field should definitely be used to specify how the corresponding product variation is different (e.g. This is the green, extra-large version of the shirt ). However, in the case of an inventory item group, the text in the description field of the inventory item group will become the listing description of the actual eBay listing instead of the text in this field. Basic HTML tags are supported, including the following tags: &lt;b&gt; &lt;strong&gt; &lt;br&gt; &lt;ol&gt; &lt;ul&gt; &lt;li&gt; Table tags including &lt;table&gt;, &lt;tr&gt;, &lt;td&gt;, &lt;th&gt;, &lt;thead&gt;, &lt;tfoot&gt;, &lt;tbody&gt;, &lt;caption&gt;, &lt;colgroup&gt;, and &lt;col&gt; A seller can not use any active content in their listing description. Active content includes animation or video via JavaScript, Flash, plug-ins, or form actions. This field is returned if defined for an inventory item. If one of the GTIN types (e.g. UPC) was passed in when the inventory item was created/modified and a product match was found in the eBay catalog, product description is one of the details that gets picked up from the catalog product. Important! Publish offer note: This field is required before an offer can be published to create an active listing. Max Length : 4000",
            "maxLength": 262144
          },
          "ean": {
            "type": "array",
            "description": "The European Article Number/International Article Number (EAN) for the product. Although an ePID value is preferred when trying to find a product match in the eBay Catalog, this field can also be used in an attempt to find a product match in the eBay Catalog. If a product match is found in the eBay Catalog, the inventory item is automatically populated with available product details such as a title, a product description, product aspects (including the specified EAN value), and a link to any stock image that exists for the catalog product. This field is returned if defined for an inventory item. If an EAN was passed in as an item specific name-value pair through the aspects array in a createOrReplaceInventoryItem call, this value is also picked up by the ean field. Note: If the item is being listed in a category that requires an EAN value, but one doesn't exist for the product, the seller must provide a string indicating that the product identifier is unavailable. This text varies by marketplace. Refer to Product Identifier Text for the specific text based on the listing marketplace.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "epid": {
            "type": "string",
            "description": "The eBay Product Identifier (ePID) for the product. This field can be used to directly identify an eBay Catalog product. Based on its specified ePID value, eBay will search for the product in the eBay Catalog, and if a match is found, the inventory item is automatically populated with available product details such as product title, product description, product aspects, and a link to any stock image that exists for the catalog product. In an attempt to find a eBay Catalog product match, an ePID value is always preferred over the other product identifiers, since it is possible that one GTIN value can be associated with multiple eBay Catalog products, and if multiple products are found, product details will not be picked up by the Inventory Item object. Note: When listing in categoryID 173651 (Auto Performance Tuning Devices & Software), the use of catalog products is required. For more information, see Tuning devices and software . This field is returned if defined for an inventory item.",
            "maxLength": 262144
          },
          "imageUrls": {
            "type": "array",
            "description": "An array of one or more links to images for the product. URLs must use the \"HTTPS\" protocol. Images can be self-hosted by the seller, or sellers can use the UploadSiteHostedPictures call of the Trading API to upload images to an eBay Picture Server. If successful, the response of the UploadSiteHostedPictures call will contain a full URL to the image on an eBay Picture Server. This is the URL that will be passed in through the imageUrls array. Before an offer can be published, at least one image must exist for the inventory item. In almost any category at no cost, sellers can include up to 24 pictures in one listing. For inventory items that are a part of an inventory item group/multiple-variation listings, a maximum of 12 pictures may be used per inventory item in the group. Motor vehicle listings are an exception. The number of included pictures in motor vehicle listings depend on the selected vehicle package (see Fees for selling vehicles on eBay Motors ). A link to a stock image for a product may automatically be populated for an inventory item if the seller specifies an eBay Product ID (ePID) or a Global Trade Item Number (GTIN) and eBay is able to find a matching product in the eBay Catalog. This container will always be returned for an inventory item that is part of a published offer since a published offer will always have at least one picture, but this container will only be returned if defined for inventory items that are not a part of a published offer. Important! Publish offer note: This array is required and at least one image URL must be specified before an offer can be published to create an active listing.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "isbn": {
            "type": "array",
            "description": "The International Standard Book Number (ISBN) value for the product. Although an ePID value is preferred when trying to find a product match in the eBay Catalog, this field can also be used in an attempt to find a product match in the eBay Catalog. If a product match is found in the eBay Catalog, the inventory item is automatically populated with available product details such as a title, a product description, product aspects (including the specified ISBN value), and a link to any stock image that exists for the catalog product. This field is returned if defined for an inventory item. If an ISBN was passed in as an item specific name-value pair through the aspects array in a createOrReplaceInventoryItem call, this value is also picked up by the isbn field. Note: If the item is being listed in a category that requires an ISBN value, but one doesn't exist for the product, the seller must provide a string indicating that the product identifier is unavailable. This text varies by marketplace. Refer to Product Identifier Text for the specific text based on the listing marketplace.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "mpn": {
            "type": "string",
            "description": "The Manufacturer Part Number (MPN) of a product. This field is paired with the brand field to identify a product. Some eBay categories require MPN values. The getItemAspectsForCategory method in the Taxonomy API can be used to see if a category requires an MPN. The MPN value for a product may automatically be populated for an inventory item if the seller specifies an eBay Product ID (ePID) or a Global Trade Item Number (GTIN) and eBay is able to find a matching product in the eBay Catalog. This field is returned if defined for an inventory item. If an MPN was passed in as an item specific name-value pair through the aspects array in a createOrReplaceInventoryItem call, this value is also picked up by the mpn field. Note: If the item is being listed in a category that requires an MPN value, but one doesn't exist for the product, the seller must provide a string indicating that the product identifier is unavailable. This text varies by marketplace. Refer to Product Identifier Text for the specific text based on the listing marketplace. Max Length : 65",
            "maxLength": 262144
          },
          "subtitle": {
            "type": "string",
            "description": "A subtitle is an optional listing feature that allows the seller to provide more information about the product, possibly including keywords that may assist with search results. An additional listing fee will be charged to the seller if a subtitle is used. For more information on using listing subtitles on the US site, see the Adding a subtitle to your listings help page. The subtitle of an existing inventory item can added, modified, or removed with a createOrReplaceInventoryItem call. Note that the same subtitle text should be used for each inventory item that will be part of an inventory item group, and ultimately become one product variation within a multiple-variation listing. This field will only be returned if set for an inventory item. Max Length : 55",
            "maxLength": 262144
          },
          "title": {
            "type": "string",
            "description": "The title of an inventory item can be added or modified with a createOrReplaceInventoryItem call. Although not immediately required, a title will be needed before an offer with the inventory item is published. The title of an inventory item is automatically populated if the seller specifies an eBay Product ID (ePID) or a Global Trade Item Number (GTIN) and eBay is able to find a matching product in the eBay Catalog. If the inventory item will become part of a single-variation offer, and the listing is not a product-based listing, the text in this field will become the actual listing title for the published offer. However, if the inventory item will become part of a multiple-variation offer, the text in title field of the inventory item group entity will actually become the listing title for the published offer instead, although a title can still be provided for the inventory item, and it will actually become the title of the variation. This field will always be returned for an inventory item that is part of a published offer since a published offer will always have a listing title, but this field will only be returned if defined for inventory items that are not a part of a published offer. Important! Publish offer note: This field is required before an offer can be published to create an active listing. Max Length : 80",
            "maxLength": 262144
          },
          "upc": {
            "type": "array",
            "description": "The Universal Product Code (UPC) value for the product. Although an ePID value is preferred when trying to find a product match in the eBay Catalog, this field can also be used in an attempt to find a product match in the eBay Catalog. If a product match is found in the eBay Catalog, the inventory item is automatically populated with available product details such as a title, a product description, product aspects (including the specified UPC value), and a link to any stock image that exists for the catalog product. This field is returned if defined for an inventory item. If a UPC was passed in as an item specific name-value pair through the aspects array in a createOrReplaceInventoryItem call, this value is also picked up by the upc field. Note: If the item is being listed in a category that requires a UPC value, but one doesn't exist for the product, the seller must provide a string indicating that the product identifier is unavailable. This text varies by marketplace. Refer to Product Identifier Text for the specific text based on the listing marketplace.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "videoIds": {
            "type": "array",
            "description": "An array of one or more videoId values for the product. A video ID is a unique identifier that is automatically created by eBay when a seller successfully uploads a video to eBay using the uploadVideo method of the Media API . For information on supported marketplaces and platforms, as well as other requirements and limitations of video support, please refer to Managing videos . Note: Only one video per listing is supported.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__BulkPriceQuantity": {
        "type": "object",
        "description": "This type is used by the base request payload of the bulkUpdatePriceQuantity call. The bulkUpdatePriceQuantity call allows the seller to update the total 'ship-to-home' quantity of one or more inventory items (up to 25) and/or to update the price and/or quantity of one or more specific published offers.",
        "properties": {
          "requests": {
            "type": "array",
            "description": "This container is used by the seller to update the total 'ship-to-home' quantity of one or more inventory items (up to 25) and/or to update the price and/or quantity of one or more specific published offers.",
            "items": {
              "$ref": "#/$defs/inventory__PriceQuantity"
            },
            "maxItems": 10,
            "minItems": 1
          }
        },
        "additionalProperties": false,
        "required": [
          "requests"
        ]
      },
      "inventory__PriceQuantity": {
        "type": "object",
        "description": "This type is used to update the total \"ship-to-home\" quantity for one or more inventory items and/or to update the price and/or quantity of one or more specific offers associated with one or more inventory items.",
        "properties": {
          "offers": {
            "type": "array",
            "description": "This container is needed if the seller is updating the price and/or quantity of one or more published offers, and a successful call will actually update the active eBay listing with the revised price and/or available quantity. This call is not designed to work with unpublished offers. For unpublished offers, the seller should use the updateOffer call to update the available quantity and/or price. If the seller is also using the shipToLocationAvailability container and sku field to update the total 'ship-to-home' quantity of the inventory item, the SKU value associated with the corresponding offerId value(s) must be the same as the corresponding sku value that is passed in, or an error will occur. Important! A separate ( OfferPriceQuantity ) node is required for each offer being updated.",
            "items": {
              "$ref": "#/$defs/inventory__OfferPriceQuantity"
            },
            "maxItems": 10
          },
          "shipToLocationAvailability": {
            "$ref": "#/$defs/inventory__ShipToLocationAvailability"
          },
          "sku": {
            "type": "string",
            "description": "This is the seller-defined SKU value of the inventory item whose total 'ship-to-home' quantity will be updated. This field is only required when the seller is updating the total quantity of an inventory item using the shipToLocationAvailability container. If the seller is updating the price and/or quantity of one or more specific offers, one or more offerId values are used instead, and the sku value is not needed. If the seller wants to update the price and/or quantity of one or more offers, and also wants to update the total 'ship-to-home' quantity of the corresponding inventory item, the SKU value associated with the offerId value(s) must be the same as the corresponding sku value that is passed in, or an error will occur. Use the getInventoryItems method to retrieve SKU values. Max Length : 50",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__OfferPriceQuantity": {
        "type": "object",
        "description": "This type is used by the offers container in a Bulk Update Price and Quantity call to update the current price and/or quantity of one or more offers associated with a specific inventory item.",
        "properties": {
          "availableQuantity": {
            "type": "integer",
            "description": "This field is used if the seller wants to modify the current quantity of the inventory item that will be available for purchase in the offer (identified by the corresponding offerId value). This value represents the quantity of the item that is available in the marketplace specified within the offer, not the total quantity available. Because of this, this value should not exceed the value specified in the quantity field of the shipToLocationAvailability container (the total available quantity of the item across all marketplaces). Note: To ensure that the available quantity allocated to a specific marketplace doesn't exceed the total available stock, the quantity specified on a listing will be the minimum value between this field and the quantity field. Either the availableQuantity field or the price container is required, but not necessarily both.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "offerId": {
            "type": "string",
            "description": "This field is the unique identifier of the offer. If an offers container is used to update one or more offers associated to a specific inventory item, the offerId value is required in order to identify the offer to update with a modified price and/or quantity. The seller can use the getOffers method (passing in the correct SKU value as a query parameter) to retrieve offerId values for offers associated with the SKU.",
            "maxLength": 262144
          },
          "price": {
            "$ref": "#/$defs/inventory__Amount"
          }
        },
        "additionalProperties": false
      },
      "inventory__Amount": {
        "type": "object",
        "description": "This type is used to express a dollar value and the applicable currency.",
        "properties": {
          "currency": {
            "type": "string",
            "description": "A three-digit string value representing the type of currency being used. Both the value and currency fields are required/always returned when expressing prices. See the CurrencyCodeEnum type for the full list of currencies and their corresponding three-digit string values.",
            "maxLength": 262144
          },
          "value": {
            "type": "string",
            "description": "A string representation of a dollar value expressed in the currency specified in the currency field. Both the value and currency fields are required/always returned when expressing prices.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__InventoryItem": {
        "type": "object",
        "description": "This type is used to provide detailed information about an inventory item.",
        "properties": {
          "availability": {
            "$ref": "#/$defs/inventory__Availability"
          },
          "condition": {
            "type": "string",
            "description": "This enumeration value indicates the condition of the item. Supported item condition values will vary by eBay site and category. To see which item condition values that a particular eBay category supports, use the getItemConditionPolicies method of the Metadata API . This method returns condition ID values that map to the enumeration values defined in the ConditionEnum type. The Item condition ID and name values topic in the Selling Integration Guide has a table that maps condition ID values to ConditionEnum values. The getItemConditionPolicies call reference page has more information. A condition value is optional up until the seller is ready to publish an offer with the SKU, at which time it becomes required for most eBay categories. Important! Publish offer note: This field is required before an offer can be published to create an active listing. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "conditionDescription": {
            "type": "string",
            "description": "This string field is used by the seller to more clearly describe the condition of a used inventory item, or an inventory item whose condition value is not NEW , LIKE_NEW , NEW_OTHER , or NEW_WITH_DEFECTS . The conditionDescription field is available for all eBay categories. If the conditionDescription field is used with an item in one of the new conditions (mentioned in previous paragraph), eBay will simply ignore this field if included, and eBay will return a warning message to the user. This field should only be used to further clarify the condition of the used item. It should not be used for branding, promotions, shipping, returns, payment or other information unrelated to the condition of the used item. Make sure that the condition value, condition description, listing description, and the item's pictures do not contradict one another. This field is not always required, but is required if an inventory item is being updated and a condition description already exists for that inventory item. This field is returned in the getInventoryItem and getInventoryItems calls if a condition description was provided for a used inventory item. Max Length : 1000.",
            "maxLength": 262144
          },
          "conditionDescriptors": {
            "type": "array",
            "description": "This container is used by the seller to provide additional information about the condition of an item in a structured format. Condition descriptors are name-value attributes that can be either closed set or open text inputs. For trading card and coin listings in applicable categories, sellers must use either LIKE_NEW (2750) or USED_VERY_GOOD (4000) item condition to specify the item as Graded or Ungraded , respectively. Use of either of these conditions requires the seller to use this array to provide one or more applicable Condition Descriptor name-value pairs. To retrieve all condition descriptor numeric IDs for a category, use the getItemConditionPolicies method of the Metadata API.",
            "items": {
              "$ref": "#/$defs/inventory__ConditionDescriptor"
            },
            "maxItems": 10
          },
          "packageWeightAndSize": {
            "$ref": "#/$defs/inventory__PackageWeightAndSize"
          },
          "product": {
            "$ref": "#/$defs/inventory__Product"
          }
        },
        "additionalProperties": false
      },
      "inventory__Compatibility": {
        "type": "object",
        "description": "This type is used by the createOrReplaceProductCompatibility call to associate compatible vehicles to an inventory item. This type is also the base response of the getProductCompatibility call.",
        "properties": {
          "compatibleProducts": {
            "type": "array",
            "description": "This container consists of an array of motor vehicles (make, model, year, trim, engine) that are compatible with the motor vehicle part or accessory specified by the sku value.",
            "items": {
              "$ref": "#/$defs/inventory__CompatibleProduct"
            },
            "maxItems": 10
          },
          "sku": {
            "type": "string",
            "description": "The seller-defined SKU value of the inventory item that will be associated with the compatible vehicles. Note: This field is not applicable to the createOrReplaceProductCompatibility method, as the SKU value for the inventory item is passed in as part of the call URI and not in the request payload. It is always returned with the getProductCompatibility method.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__CompatibleProduct": {
        "type": "object",
        "description": "This type is used to specify/indicate the motor vehicles that are compatible with the corresponding inventory item.",
        "properties": {
          "compatibilityProperties": {
            "type": "array",
            "description": "This container consists of an array of motor vehicles that are compatible with the motor vehicle part or accessory specified by the SKU value in the call URI. Each motor vehicle is defined through a separate set of name/value pairs. In the name field, the vehicle aspect (such as 'make', 'model', 'year', 'trim', or 'engine') will be identified, and the value field will be used to identify the value of each aspect. The getCompatibilityProperties method of the Taxonomy API can be used to retrieve applicable vehicle aspect names for a specified category, and the getCompatibilityPropertyValues method of the Taxonomy API can be used to retrieve possible values for these same vehicle aspect names. Below is an example of identifying one motor vehicle using the compatibilityProperties container: &quot;compatibilityProperties&quot; : &#91; &nbsp;&nbsp;&#123; &nbsp;&nbsp;&nbsp;&quot;name&quot; : &quot;make&quot;, &nbsp;&nbsp;&nbsp;&quot;value&quot; : &quot;Subaru&quot; &nbsp;&nbsp;&#125;, &nbsp;&nbsp;&#123; &nbsp;&nbsp;&nbsp;&quot;name&quot; : &quot;model&quot;, &nbsp;&nbsp;&nbsp;&quot;value&quot; : &quot;GL&quot; &nbsp;&nbsp;&#125;, &nbsp;&nbsp;&#123; &nbsp;&nbsp;&nbsp;&quot;name&quot; : &quot;year&quot;, &nbsp;&nbsp;&nbsp;&quot;value&quot; : &quot;1983&quot; &nbsp;&nbsp;&#125;, &nbsp;&nbsp;&#123; &nbsp;&nbsp;&nbsp;&quot;name&quot; : &quot;trim&quot;, &nbsp;&nbsp;&nbsp;&quot;value&quot; : &quot;Base Wagon 4-Door&quot; &nbsp;&nbsp;&#125;, &nbsp;&nbsp;&#123; &nbsp;&nbsp;&nbsp;&quot;name&quot; : &quot;engine&quot;, &nbsp;&nbsp;&nbsp;&quot;value&quot; : &quot;1.8L Turbocharged&quot; &nbsp;&nbsp;&#125; &#93; Typically, the make, model, and year of the motor vehicle are always required, with the trim and engine being necessary sometimes, but it will be dependent on the part or accessory, and on the vehicle class. Note: The productFamilyProperties container is deprecated and should no longer be used. The compatibilityProperties container should be used instead.",
            "items": {
              "$ref": "#/$defs/inventory__NameValueList"
            },
            "maxItems": 10
          },
          "notes": {
            "type": "string",
            "description": "This field is used by the seller to input any notes pertaining to the compatible vehicle list being defined. The seller might use this field to specify the placement of the part on a vehicle or other applicable information. This field will only be returned if specified by the seller. Max Length : 500",
            "maxLength": 262144
          },
          "productFamilyProperties": {
            "$ref": "#/$defs/inventory__ProductFamilyProperties"
          },
          "productIdentifier": {
            "$ref": "#/$defs/inventory__ProductIdentifier"
          }
        },
        "additionalProperties": false
      },
      "inventory__NameValueList": {
        "type": "object",
        "description": "This type is used by the compatibilityProperties container to identify a motor vehicle using name/value pairs.",
        "properties": {
          "name": {
            "type": "string",
            "description": "This string value identifies the motor vehicle aspect, such as 'make', 'model', 'year', 'trim', and 'engine'. Typically, the make, model, and year of the motor vehicle are always required, with the trim and engine being necessary sometimes, but it will be dependent on the part or accessory, and on the vehicle class. The getCompatibilityProperties method of the Taxonomy API can be used to retrieve applicable vehicle aspect names for a specified category.",
            "maxLength": 262144
          },
          "value": {
            "type": "string",
            "description": "This string value identifies the motor vehicle aspect specified in the corresponding name field. For example, if the name field is 'make', this field may be 'Toyota', or if the name field is 'model', this field may be 'Camry'. The getCompatibilityPropertyValues method of the Taxonomy API can be used to retrieve possible values for vehicle aspect names.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__ProductFamilyProperties": {
        "type": "object",
        "description": "This type is used to specify the details of a motor vehicle that is compatible with the inventory item specified through the SKU value in the call URI.",
        "properties": {
          "engine": {
            "type": "string",
            "description": "Important! The productFamilyProperties container is no longer supported.",
            "maxLength": 262144
          },
          "make": {
            "type": "string",
            "description": "Important! The productFamilyProperties container is no longer supported.",
            "maxLength": 262144
          },
          "model": {
            "type": "string",
            "description": "Important! The productFamilyProperties container is no longer supported.",
            "maxLength": 262144
          },
          "trim": {
            "type": "string",
            "description": "Important! The productFamilyProperties container is no longer supported.",
            "maxLength": 262144
          },
          "year": {
            "type": "string",
            "description": "Important! The productFamilyProperties container is no longer supported.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__ProductIdentifier": {
        "type": "object",
        "description": "This type is used to identify a motor vehicle that is compatible with the corresponding inventory item (the SKU that is passed in as part of the call URI). The motor vehicle can be identified through an eBay Product ID or a K-Type value. The gtin field (for inputting Global Trade Item Numbers) is for future use only. If a motor vehicle is found in the eBay product catalog, the motor vehicle properties (engine, make, model, trim, and year) will automatically get picked up for that motor vehicle. Note: Currently, parts compatibility is only applicable for motor vehicles, but it is possible that the Product Compatibility feature is expanded to other (non-vehicle) products in the future.",
        "properties": {
          "epid": {
            "type": "string",
            "description": "This field can be used if the seller already knows the eBay catalog product ID (ePID) associated with the motor vehicle that is to be added to the compatible product list. If this eBay catalog product ID is found in the eBay product catalog, the motor vehicle properties (e.g. make, model, year, engine, and trim) will automatically get picked up for that motor vehicle.",
            "maxLength": 262144
          },
          "gtin": {
            "type": "string",
            "description": "This field can be used if the seller knows the Global Trade Item Number for the motor vehicle that is to be added to the compatible product list. If this GTIN value is found in the eBay product catalog, the motor vehicle properties (e.g. make, model, year, engine, and trim will automatically get picked up for that motor vehicle. Note: This field is for future use.",
            "maxLength": 262144
          },
          "ktype": {
            "type": "string",
            "description": "This field can be used if the seller knows the K Type Number for the motor vehicle that is to be added to the compatible product list. If this K Type value is found in the eBay product catalog, the motor vehicle properties (e.g. make, model, year, engine, and trim) will automatically get picked up for that motor vehicle. Only the AU, DE, ES, FR, IT, and UK marketplaces support the use of K Type Numbers.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__InventoryItemGroup": {
        "type": "object",
        "description": "This type is used by the base request payload of the createOrReplaceInventoryItemGroup call and the base response payload of the getInventoryItemGroup call.",
        "properties": {
          "aspects": {
            "type": "object",
            "description": "This is a collection of item specifics (aka product aspects) name-value pairs that are shared by all product variations within the inventory item group. Common aspects for the inventory item group are not immediately required upon creating an inventory item group, but these aspects will be required before the first offer of the group is published. Common aspects for a men's t-shirt might be pattern and sleeve length. Important! Effective from December 28th, 2024, sellers offering certain rechargeable devices in EU and Northern Ireland markets must comply with the Common Charger Directive (CCD) and list appropriate charger-related aspects and values on their listings. See Common Charger Directive for more information. Below is an example of the proper JSON syntax to use when manually inputting item specifics. Note that one item specific name, such as 'Features', can have more than one value. If an item specific name has more than one value, each value is delimited with a comma. \"aspects\": { \"pattern\": [\"solid\"], \"sleeves\": [\"short\"] } This container is always returned if one or more offers associated with the inventory item group have been published, and is only returned if set for an inventory item group if that group has yet to have any offers published. Important! Publish offer note: This field is required before an offer can be published to create an active listing.",
            "additionalProperties": {
              "type": "array",
              "items": {
                "type": "string",
                "maxLength": 262144
              },
              "maxItems": 10
            }
          },
          "description": {
            "type": "string",
            "description": "The description of the inventory item group. This description should fully describe the product and the variations of the product that are available in the inventory item group, since this description will ultimately become the listing description once the first offer of the group is published. This field is not initially required when first creating an inventory item group, but will be required before the first offer of the group is published. Note: Since this description will ultimately become the listing description in a multiple-variation listing, the seller should omit the listingDescription field when creating the offers for each variation. If they include the listingDescription field for the individual offer(s) in an item group, the text in that field for a published offer will overwrite the text provided in this description field for the inventory item group. HTML tags and markup can be used in this field, but each character counts toward the max length limit. Note: To ensure that their short listing description is optimized when viewed on mobile devices, sellers should strongly consider using eBay's View Item description summary feature when listing their items. Keep in mind that the 'short' listing description is what prospective buyers first see when they view the listing on a mobile device. The 'full' listing description is also available to mobile users when they click on the short listing description, but the full description is not automatically optimized for viewing in mobile devices, and many users won't even drill down to the full description. Using HTML div and span tag attributes, this feature allows sellers to customize and fully control the short listing description that is displayed to prospective buyers when viewing the listing on a mobile device. The short listing description on mobile devices is limited to 800 characters, and whenever the full listing description (provided in this field, in UI, or seller tool) exceeds this limit, eBay uses a special algorithm to derive the best possible short listing description within the 800-character limit. However, due to some short listing description content being removed, it is definitely not ideal for the seller, and could lead to a bad buyer experience and possibly to a Significantly not as described (SNAD) case, since the buyer may not get complete details on the item when viewing the short listing description. See the eBay help page for more details on using the HTML div and span tags. This field is always returned if one or more offers associated with the inventory item group have been published, and is only returned if set for an inventory item group if that group has yet to have any offers published. Important! Publish offer note: This field is required before an offer can be published to create an active listing. Max Length : 500000 (which includes HTML markup/tags)",
            "maxLength": 262144
          },
          "imageUrls": {
            "type": "array",
            "description": "An array of one or more links to images for the inventory item group. URLs must use the \"HTTPS\" protocol. Images can be self-hosted by the seller, or sellers can use the UploadSiteHostedPictures call of the Trading API to upload images to an eBay Picture Server. If successful, the response of the UploadSiteHostedPictures call will contain a full URL to the image on an eBay Picture Server. This is the URL that will be passed in through the imageUrls array. Note: Before any offer can be published, at least one image must exist for the offer. Links to images can either be passed in through this imageUrls container, or they can be passed in through the product.imageUrls container when creating each inventory item in the group. If the variesBy.aspectsImageVariesBy field is used to specify the main product aspect where the variations vary, the links to the images must be passed in through this imageUrls container, and there should be a picture for each variation. So, if the variesBy.aspectsImageVariesBy field is set to Color , a link should be included to an image demonstrating each available color in the group. In almost any category at no cost, sellers can include up to 24 pictures in one listing. For inventory items that are a part of an inventory item group/multiple-variation listings, a maximum of 12 pictures may be used per inventory item in the group. Motor vehicle listings are an exception. The number of included pictures in motor vehicle listings depend on the selected vehicle package (see Fees for selling vehicles on eBay Motors ). This container will always be returned for an inventory item group that has at least one published offer since a published offer will always have at least one picture, but this container will only be returned if defined for inventory item groups that have yet to have any published offers.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "inventoryItemGroupKey": {
            "type": "string",
            "description": "This is the unique identifier of the inventory item group. This identifier is created by the seller when an inventory item group is created. Note: This field is only applicable to the getInventoryItemGroup call and not to the createOrReplaceInventoryItemGroup call. In the createOrReplaceInventoryItemGroup call, the inventoryItemGroupKey value is passed into the end of the call URI instead.",
            "maxLength": 262144
          },
          "subtitle": {
            "type": "string",
            "description": "A subtitle is an optional listing feature that allows the seller to provide more information about the product, possibly including keywords that may assist with search results. An additional listing fee will be charged to the seller if a subtitle is used. For more information on using listing subtitles on the US site, see the Adding a subtitle to your listings help page. Note: Since this subtitle will ultimately become the subtitle in a multiple-variation listing, the seller should not include the subtitle field when creating the inventory items that are members of the group. If they do include the subtitle field in an inventory item record, the text in that field will overwrite the text provided in this subtitle field for each inventory item in the group that is published. This field will only be returned if set for an inventory item. Max Length : 55",
            "maxLength": 262144
          },
          "title": {
            "type": "string",
            "description": "The title of the inventory item group. This title will ultimately become the listing title once the first offer of the group is published. This field is not initially required when first creating an inventory item group, but will be required before the first offer of the group is published. Note: Since this title will ultimately become the listing title in a multiple-variation listing, the seller should omit the title field when creating the inventory items that are members of the group. If they do include the title field in an inventory item record, the text in that field will overwrite the text provided in this title field for each inventory item in the group that is published. This field is always returned if one or more offers associated with the inventory item group have been published, and is only returned if set for an inventory item group if that group has yet to have any offers published. Important! Publish offer note: This field is required before an offer can be published to create an active listing. Max Length : 80",
            "maxLength": 262144
          },
          "variantSKUs": {
            "type": "array",
            "description": "This required container is used to assign individual inventory items to the inventory item group. Multiple SKU values are passed in to this container. If updating an existing inventory item group, the seller should make sure that all member SKU values are passed in, as long as the seller wants that SKU to remain in the group. It is also possible to add or remove SKUs with a createOrReplaceInventoryItemGroup call. If the seller wants to remove a SKU from the group, that seller will just omit that SKU value from this container to remove that inventory item/SKU from the inventory item group and any published, multiple-variation listing. However, a variation cannot be removed from the group if that variation has one or more sales for that listing. A workaround for this is to set that variation's quantity to 0 and it will be 'grayed out' in the View Item page. This container is always returned.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "variesBy": {
            "$ref": "#/$defs/inventory__VariesBy"
          },
          "videoIds": {
            "type": "array",
            "description": "An array of one or more videoId values for the inventory item group. A video ID is a unique identifier that is automatically created by eBay when a seller successfully uploads a video to eBay using the uploadVideo method of the Media API . For information on supported marketplaces and platforms, as well as other requirements and limitations of video support, please refer to Managing videos . Note: Only one video per listing is supported.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__VariesBy": {
        "type": "object",
        "description": "This type is used to specify the product aspect(s) where individual items of the group vary, as well as a list of the available variations of those aspects.",
        "properties": {
          "aspectsImageVariesBy": {
            "type": "array",
            "description": "This container is used if the seller wants to include multiple images to demonstrate how variations within a multiple-variation listing differ. In this string field, the seller will specify the product aspect where the variations of the inventory item group vary, such as color. If Color is specified in this field, Color must also be one of the specifications.name values, and all available colors must appear in the corresponding specifications.values array. If the aspectsImageVariesBy container is used, links to images of each variation should be specified through the imageUrls container of the inventory item group, or the seller can choose to include those links to images in each inventory item record for the inventory items in the group. Important! Publish offer note: This array is required and at least one aspect (such as Color ) must be specified before an offer can be published to create an active listing.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "specifications": {
            "type": "array",
            "description": "This container consists of an array of one or more product aspects where each variation differs, and values for each of those product aspects. This container is not immediately required, but will be required before the first offer of the inventory item group is published. If a product aspect is specified in the aspectsImageVariesBy container, this product aspect (along with all variations of that product aspect) must be included in the specifications container. Before offers related to the inventory item group are published, the product aspects and values specified through the specifications container should be in synch with the name-value pairs specified through the product.aspects containers of the inventory items contained in the group. For example, if Color and Size are in this specifications container, each inventory item of the group should also have Color and Size as aspect names in their inventory item records. This container is always returned if one or more offers associated with the inventory item group have been published. For inventory item groups that have yet to have any published offers, this container is only returned if set. Important! Publish offer note: This array is required and at least one aspect with the available variations must be specified.",
            "items": {
              "$ref": "#/$defs/inventory__Specification"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__Specification": {
        "type": "object",
        "description": "This type is used to specify product aspects for which variations within an inventory item group vary, and the order in which they appear in the listing. For example, t-shirts in an inventory item group may be available in multiple sizes and colors.",
        "properties": {
          "name": {
            "type": "string",
            "description": "This is the name of product variation aspect. Typically, for clothing, typical aspect names are \"Size\" and \"Color\" . Product variation aspects are not required immediately upon creating an inventory item group, but these aspects will be required before a multiple-variation listing containing this inventory item group is published. For each product variation aspect that is specified through the specifications container, one name value is required and two or more variations of this aspect are required through the values array. Note: Each member of the inventory item group should have these same aspect names specified through the product.aspects container when the inventory item is created with the createOrReplaceInventoryItem or bulkCreateOrReplaceInventoryItem call. Important! Publish offer note: This field is required before an offer can be published to create an active listing. Max Length : 40",
            "maxLength": 262144
          },
          "values": {
            "type": "array",
            "description": "This is an array of values pertaining to the corresponding product variation aspect (specified in the name field). Below is a sample of how these values will appear under a specifications container: \"specifications\": [{ \"name\": \"Size\", \"values\": [\"Small\", \"Medium\", \"Large\"] }, { \"name\": \"Color\", \"values\": [\"Blue\", \"White\", \"Red\"] }] Note: Each member of the inventory item group should have these same aspect names, and each individual inventory item should have each variation of the product aspect values specified through the product.aspects container when the inventory item is created with the createOrReplaceInventoryItem or bulkCreateOrReplaceInventoryItem call. Important! Publish offer note: This array is required and at least one value that matches the corresponding aspect name must be specified. Max Length : 50",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__BulkMigrateListing": {
        "type": "object",
        "description": "This type is used by the base container of the bulkMigrateListings request payload.",
        "properties": {
          "requests": {
            "type": "array",
            "description": "This is the base container of the bulkMigrateListings request payload. One to five eBay listings will be included under this container.",
            "items": {
              "$ref": "#/$defs/inventory__MigrateListing"
            },
            "maxItems": 5,
            "minItems": 1
          }
        },
        "additionalProperties": false,
        "required": [
          "requests"
        ]
      },
      "inventory__MigrateListing": {
        "type": "object",
        "description": "This type is used to specify one to five eBay listings that will be migrated to the new Inventory model.",
        "properties": {
          "listingId": {
            "type": "string",
            "description": "The unique identifier of the eBay listing to migrate to the new Inventory model. In the Trading API, this field is known as the ItemID . Up to five unique eBay listings may be specified here in separate listingId fields. The seller should make sure that each of these listings meet the requirements that are stated at the top of this Call Reference page.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__LocationMapping": {
        "type": "object",
        "description": "This type provides an array of locations that are associated with a SKU within a listing.",
        "properties": {
          "locations": {
            "type": "array",
            "description": "This array represents a collection of fulfillment center locations mapped to a SKU. Note: Only the first 50 locations mapped to a SKU will be considered when calculating estimated delivery dates. Sellers can set up more than 50 locations using this method, but only the first 50 locations will be considered for calculating the estimates.",
            "items": {
              "$ref": "#/$defs/inventory__LocationAvailabilityDetails"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__LocationAvailabilityDetails": {
        "type": "object",
        "description": "This type provides the unique identifier of an inventory location that is associated with a SKU within a listing.",
        "properties": {
          "merchantLocationKey": {
            "type": "string",
            "description": "The unique identifier of a seller’s fulfillment center location where inventory is available for the item or item variation. Note: When creating a location mapping using the createOrReplaceSkuLocationMapping method, the value entered in this field must be associated with a location with the FULFILLMENT_CENTER location type, or an error will occur. Sellers can check the locationTypes array in the response of the getInventoryLocations method to see if their location has a value of FULFILLMENT_CENTER .",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__BulkOffer": {
        "type": "object",
        "description": "This type is used by the base request of the bulkPublishOffer method, which is used to publish up to 25 different offers.",
        "properties": {
          "requests": {
            "type": "array",
            "description": "This container is used to pass in an array of offers to publish. Up to 25 offers can be published with one bulkPublishOffer method.",
            "items": {
              "$ref": "#/$defs/inventory__OfferKeyWithId"
            },
            "maxItems": 10,
            "minItems": 1
          }
        },
        "additionalProperties": false,
        "required": [
          "requests"
        ]
      },
      "inventory__OfferKeyWithId": {
        "type": "object",
        "description": "This type is used by the getListingFees call to indicate the unpublished offer(s) for which expected listing fees will be retrieved. The user passes in one or more offerId values (a maximum of 250). See the Standard selling fees help page for more information on listing fees.",
        "properties": {
          "offerId": {
            "type": "string",
            "description": "The unique identifier of an unpublished offer for which expected listing fees will be retrieved. One to 250 offerId values can be passed in to the offers container for one getListingFees call. Use the getOffers method to retrieve offer IDs. Note: Errors will occur if offerId values representing published offers are passed in.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__EbayOfferDetailsWithId": {
        "type": "object",
        "description": "updateOffer call. Every field that is currently set with the unpublished/published offer must also be passed into the updateOffer call, even those fields whose values are not changing. Note that for published offers, a successful updateOffer call will actually update the active eBay listing with whatever changes were made.",
        "properties": {
          "availableQuantity": {
            "type": "integer",
            "description": "This integer value sets the quantity of the inventory item that will be available through the offer. Quantity must be set to 1 or more in order for the inventory item to be purchasable. This value should not be more than the quantity that is specified for the inventory item record. For auction listings, this field should not be provided. If this field exists for the current unpublished or published offer, it should be provided again in the updateOffer call, even if the value is not changing. If this particular field is omitted in an updateOffer call, the general available quantity set for the inventory item record may be used instead, and this may not be accurate if the inventory item is being sold across multiple marketplaces.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "categoryId": {
            "type": "string",
            "description": "The unique identifier of the eBay category that the inventory item is/will be listed under. This field is not immediately required for an unpublished offer, but will be required before publishing the offer. Sellers can use the getCategorySuggestions method of the Taxonomy API to retrieve suggested category ID values. The seller passes in a query string like \" iPhone 6 \", and category ID values for suggested categories are returned in the response. If this field exists for the current unpublished offer, it should be provided again in the updateOffer call, even if the eBay category is not changing. For a published offer (aka active eBay listing), this field must be provided or an error may occur. The eBay category of an active eBay listing cannot be changed once the listing has one or more sales, or if the listing is scheduled to end in less than 12 hours. Important! Publish offer note: This field is required before an offer can be published to create an active listing.",
            "maxLength": 262144
          },
          "charity": {
            "$ref": "#/$defs/inventory__Charity"
          },
          "extendedProducerResponsibility": {
            "$ref": "#/$defs/inventory__ExtendedProducerResponsibility"
          },
          "hideBuyerDetails": {
            "type": "boolean",
            "description": "This field is included and set to true if the seller wishes to update a published or unpublished offer with the private listing feature. Alternatively, the seller could also remove the private listing feature (if already set for a published or unpublished offer) by including this field and setting it to false . Sellers may want to use this option when they believe that a listing's potential bidders/buyers would not want their obfuscated user IDs (and feedback scores) exposed to other users."
          },
          "includeCatalogProductDetails": {
            "type": "boolean",
            "description": "This field indicates whether or not eBay product catalog details are applied to a listing. A value of true indicates the listing corresponds to the eBay product associated with the provided product identifier. The product identifier is provided in createOrReplaceInventoryItem . Note: Though the includeCatalogProductDetails parameter is not required to be submitted in the request, the parameter defaults to 'true' if omitted."
          },
          "listingDescription": {
            "type": "string",
            "description": "The text in this field is (published offers), or will become (unpublished offers) the description of the eBay listing. This field is not immediately required for an unpublished offer, but will be required before publishing the offer. Note that if the listingDescription field was omitted in the createOffer call for the offer, the offer entity should have picked up the text provided in the product.description field of the inventory item record, or if the inventory item is part of a group, the offer entity should have picked up the text provided in the description field of the inventory item group record. HTML tags and markup can be used in listing descriptions, but each character counts toward the max length limit. Note: To ensure that their short listing description is optimized when viewed on mobile devices, sellers should strongly consider using eBay's View Item description summary feature when listing their items. Keep in mind that the 'short' listing description is what prospective buyers first see when they view the listing on a mobile device. The 'full' listing description is also available to mobile users when they click on the short listing description, but the full description is not automatically optimized for viewing in mobile devices, and many users won't even drill down to the full description. Using HTML div and span tag attributes, this feature allows sellers to customize and fully control the short listing description that is displayed to prospective buyers when viewing the listing on a mobile device. The short listing description on mobile devices is limited to 800 characters, and whenever the full listing description (provided in this field, in UI, or seller tool) exceeds this limit, eBay uses a special algorithm to derive the best possible short listing description within the 800-character limit. However, due to some short listing description content being removed, it is definitely not ideal for the seller, and could lead to a bad buyer experience and possibly to a Significantly not as described (SNAD) case, since the buyer may not get complete details on the item when viewing the short listing description. See the eBay help page for more details on using the HTML div and span tags. If this field exists for the current unpublished offer, it should be provided again in the updateOffer call, even if the text is not changing. For a published offer (aka active eBay listing), this field must be provided or an error may occur. Max length : 500000 (which includes HTML markup/tags)",
            "maxLength": 262144
          },
          "listingDuration": {
            "type": "string",
            "description": "This field indicates the number of days that the listing will be active. For fixed-price listings, this value must be set to GTC , but auction listings support different listing durations. The GTC (Good 'Til Cancelled) listings are automatically renewed each calendar month until the seller decides to end the listing. Note: If the listing duration expires for an auction offer without a winning bidder, the listing then becomes available as a fixed-price offer and listing duration will be GTC . Important! Publish offer note: This field is required before an offer can be published to create an active listing. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "listingPolicies": {
            "$ref": "#/$defs/inventory__ListingPolicies"
          },
          "listingStartDate": {
            "type": "string",
            "description": "This field can be used with an unpublished offer if the seller wants to specify a time in the future that the listing will become active on eBay. The timestamp supplied in this field should be in UTC format, and it should be far enough in the future so that the seller will have enough time to publish the listing with the publishOffer method. For example: 2023-05-30T19:08:00Z. This field is optional, and it doesn't apply to offers where the corresponding listing is already active. If this field is not provided, the listing starts immediately after a successful publishOffer method.",
            "maxLength": 262144
          },
          "lotSize": {
            "type": "integer",
            "description": "This field is only applicable if the listing is a lot listing. A lot listing is a listing that has multiple quantity of the same item, such as four identical tires being sold as a single offer, or it can be a mixed lot of similar items, such as used clothing items or an assortment of baseball cards. Whether the lot listing involved identical items or a mixed lot, the integer value passed into this field is the total number of items in the lot. Lots can be used for auction and fixed-price listings.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "merchantLocationKey": {
            "type": "string",
            "description": "The unique identifier of a merchant's inventory location (where the inventory item in the offer is located). To get more information about inventory locations, the getInventoryLocations method can be used.br> Note: This field is not initially required upon first creating an offer, but will become required before an offer can be published. Max length : 36",
            "maxLength": 262144
          },
          "pricingSummary": {
            "$ref": "#/$defs/inventory__PricingSummary"
          },
          "quantityLimitPerBuyer": {
            "type": "integer",
            "description": "This field is only applicable and set if the seller wishes to set a restriction on the purchase quantity per seller. If this field is set by the seller for the offer, then each distinct buyer may purchase up to, but not exceeding the quantity specified for this field. So, if this field's value is 5 , each buyer may purchase between one to five of these products, and the purchases can occur in one multiple-quantity purchase, or over multiple transactions. If a buyer attempts to purchase one or more of these products, and the cumulative quantity will take the buyer beyond the quantity limit, that buyer will be blocked from that purchase. If this field currently exists for an unpublished or published offer, it should be provided again in an updateOffer call, even if the value is not changing.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "regulatory": {
            "$ref": "#/$defs/inventory__Regulatory"
          },
          "secondaryCategoryId": {
            "type": "string",
            "description": "The unique identifier for a secondary category. This field is applicable if the seller decides to list the item under two categories. Sellers can use the getCategorySuggestions method of the Taxonomy API to retrieve suggested category ID values. A fee may be charged when adding a secondary category to a listing. Note: You cannot list US eBay Motors vehicles in two categories. However, you can list Parts & Accessories in two categories.",
            "maxLength": 262144
          },
          "storeCategoryNames": {
            "type": "array",
            "description": "This container is used if the seller would like to place the inventory item into one or two store categories that the seller has set up for their eBay store. The string value(s) passed in to this container will be the full path(s) to the store categories, as shown below: \"storeCategoryNames\": [ \"/Fashion/Men/Shirts\", \"/Fashion/Men/Accessories\" ], If this field currently exists for an unpublished or published offer, it should be provided again in an updateOffer call, even if the eBay categories are not changing.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "tax": {
            "$ref": "#/$defs/inventory__Tax"
          }
        },
        "additionalProperties": false
      },
      "inventory__Charity": {
        "type": "object",
        "description": "This type is used to identify the charitable organization associated with the listing, and the percentage of the sale proceeds that the charitable organization will receive for each sale generated by the listing. In order to receive a percentage of the sales proceeds, the charitable organization must be registered with the PayPal Giving Fund, which is a partner of eBay for Charity.",
        "properties": {
          "charityId": {
            "type": "string",
            "description": "The eBay-assigned unique identifier of the charitable organization that will receive a percentage of the sales proceeds. The charitable organization must be reqistered with the PayPal Giving Fund in order to receive sales proceeds through eBay listings. This field is conditionally required if a seller is planning on donating a percentage of the sale proceeds to a charitable organization. The eBay-assigned unique identifier of a charitable organization can be found using the getCharityOrgs method of the Charity API. In the getCharityOrgs response, this unique identifier is shown in the charityOrgId field.",
            "maxLength": 262144
          },
          "donationPercentage": {
            "type": "string",
            "description": "This field is the percentage of the purchase price that the charitable organization (identified in the charityId field) will receive for each sale that the listing generates. This field is conditionally required if a seller is planning on donating a percentage of the sale proceeds to a charitable organization. This numeric value can range from 10 to 100, and in any 5 (percent) increments in between this range (e.g. 10 , 15 , 20 ... 95 ,... 100 ). The seller would pass in 10 for 10 percent, 15 for 15 percent, 20 for 20 percent, and so on, all the way to 100 for 100 percent.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__ExtendedProducerResponsibility": {
        "type": "object",
        "description": "This type provides IDs for the producer or importer related to the new item, packaging, added documentation, or an eco-participation fee. In some markets, such as in France, this may be the importer of the item.",
        "properties": {
          "ecoParticipationFee": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "producerProductId": {
            "type": "string",
            "description": "Note: THIS FIELD IS DEPRECATED AND NO LONGER SUPPORTED. For sellers selling on the eBay France Marketplace, Extended Producer Responsibility ID fields are no longer set at the listing level. Instead, sellers must provide these IDs for each applicable category in their My eBay accounts. The URL will be based on the seller's home/registration site, and will use this pattern: https://accountsettings./epr-fr. Sellers based in the US will use https://accountsettings.ebay.com/epr-fr , sellers based in France will use https://accountsettings.ebay.fr/epr-fr , and so on.",
            "maxLength": 262144
          },
          "productDocumentationId": {
            "type": "string",
            "description": "Note: THIS FIELD IS DEPRECATED AND NO LONGER SUPPORTED. For sellers selling on the eBay France Marketplace, Extended Producer Responsibility ID fields are no longer set at the listing level. Instead, sellers must provide these IDs for each applicable category in their My eBay accounts. The URL will be based on the seller's home/registration site, and will use this pattern: https://accountsettings./epr-fr. Sellers based in the US will use https://accountsettings.ebay.com/epr-fr , sellers based in France will use https://accountsettings.ebay.fr/epr-fr , and so on.",
            "maxLength": 262144
          },
          "productPackageId": {
            "type": "string",
            "description": "Note: THIS FIELD IS DEPRECATED AND NO LONGER SUPPORTED. For sellers selling on the eBay France Marketplace, Extended Producer Responsibility ID fields are no longer set at the listing level. Instead, sellers must provide these IDs for each applicable category in their My eBay accounts. The URL will be based on the seller's home/registration site, and will use this pattern: https://accountsettings./epr-fr. Sellers based in the US will use https://accountsettings.ebay.com/epr-fr , sellers based in France will use https://accountsettings.ebay.fr/epr-fr , and so on.",
            "maxLength": 262144
          },
          "shipmentPackageId": {
            "type": "string",
            "description": "Note: THIS FIELD IS DEPRECATED AND NO LONGER SUPPORTED. For sellers selling on the eBay France Marketplace, Extended Producer Responsibility ID fields are no longer set at the listing level. Instead, sellers must provide these IDs for each applicable category in their My eBay accounts. The URL will be based on the seller's home/registration site, and will use this pattern: https://accountsettings./epr-fr. Sellers based in the US will use https://accountsettings.ebay.com/epr-fr , sellers based in France will use https://accountsettings.ebay.fr/epr-fr , and so on.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__ListingPolicies": {
        "type": "object",
        "description": "This type is used to identify business policies including payment, return, and fulfillment policies, as well as to identify custom policies. These policies are, or will be, associated with the listing. Every published offer must have a payment, return, and fulfillment business policy associated with it. Additionally, depending on the country/countries in which sellers are offering products and/or services to consumers (e.g., residents of the European Union,) specifying additional polices may be required. This type is also used to override the shipping costs of one or more shipping service options that are associated with the fulfillment policy, to enable eBay Plus eligibility for a listing, or to enable the Best Offer feature on the listing.",
        "properties": {
          "bestOfferTerms": {
            "$ref": "#/$defs/inventory__BestOffer"
          },
          "eBayPlusIfEligible": {
            "type": "boolean",
            "description": "This field is included in an offer and set to true if a Top-Rated seller is opted in to the eBay Plus program. With the eBay Plus program, qualified sellers must commit to next-day delivery of the item, and the buyers must have an eBay Plus subscription to be eligible to receive the benefits of this program, which are free, next-day delivery, as well as free returns. Note: Currently, this program is only available on the Germany and Australian sites. This field will be returned in the getOffer and getOffers methods if set for the offer."
          },
          "fulfillmentPolicyId": {
            "type": "string",
            "description": "This unique identifier indicates the fulfillment business policy that will be used once an offer is published and converted to an eBay listing. This fulfillment business policy will set all fulfillment-related settings for the eBay listing. Business policies are not immediately required for offers, but are required before an offer can be published. The seller should review the fulfillment business policy before assigning it to the offer to make sure it is compatible with the inventory item and the offer settings. The seller may also want to review the shipping service costs in the fulfillment policy, and that seller might decide to override the shipping costs for one or more shipping service options by using the shippingCostOverrides container. Business policies can be created and managed in My eBay or with the Account API . To get a list of all return policies associated with a seller's account on a specific eBay Marketplace, use the Account API's getFulfillmentPolicies method. There are also calls in the Account API to retrieve a fulfillment policy by policy ID or policy name. This field will be returned in the getOffer and getOffers methods if set for the offer. Important! Publish offer note: This field is required before an offer can be published to create an active listing.",
            "maxLength": 262144
          },
          "paymentPolicyId": {
            "type": "string",
            "description": "This unique identifier indicates the payment business policy that will be used once an offer is published and converted to an eBay listing. This payment business policy will set all payment-related settings for the eBay listing. Business policies are not immediately required for offers, but are required before an offer can be published. The seller should review the payment business policy to make sure that it is compatible with the marketplace and listing category before assigning it to the offer. Business policies can be created and managed in My eBay or with the Account API . To get a list of all payment policies associated with a seller's account on a specific eBay Marketplace, use the Account API's getPaymentPolicies method. There are also calls in the Account API to retrieve a payment policy by policy ID or policy name. This field will be returned in the getOffer and getOffers methods if set for the offer. Important! Publish offer note: This field is required before an offer can be published to create an active listing.",
            "maxLength": 262144
          },
          "productCompliancePolicyIds": {
            "type": "array",
            "description": "This field contains the array of unique identifiers indicating the seller-created global product compliance policies that will be used once an offer is published and converted to a listing. Product compliance policies provide buyers with important information and disclosures about products. For example, if you sell batteries and specific disclosures are required to be shared with all potential buyers, your global product compliance policy could contain the required disclosures. A maximum of six (6) global product compliance policies may apply to each offer . Note: For countries that support country-specific policies, use regionalProductCompliancePolicies to apply them to an offer.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "regionalProductCompliancePolicies": {
            "$ref": "#/$defs/inventory__RegionalProductCompliancePolicies"
          },
          "regionalTakeBackPolicies": {
            "$ref": "#/$defs/inventory__RegionalTakeBackPolicies"
          },
          "returnPolicyId": {
            "type": "string",
            "description": "This unique identifier indicates the return business policy that will be used once an offer is published and converted to an eBay listing. This return business policy will set all return policy settings for the eBay listing. Note: As a part of Digital Services Act (DSA) requirements, as of April 3, 2023, buyers in the EU must be allowed to return an item within 14 days or more, unless the item is exempt. Where applicable, sellers should update their return policies to reflect this requirement of accepting returns from EU buyers. Business policies are not immediately required for offers, but are required before an offer can be published. The seller should review the return business policy before assigning it to the offer to make sure it is compatible with the inventory item and the offer settings. Business policies can be created and managed in My eBay or with the Account API . To get a list of all return policies associated with a seller's account on a specific eBay Marketplace, use the Account API's getReturnPolicies call. There are also calls in the Account API to retrieve a return policy by policy ID or policy name. This field will be returned in the getOffer and getOffers methods if set for the offer. Important! Publish offer note: This field is required before an offer can be published to create an active listing.",
            "maxLength": 262144
          },
          "shippingCostOverrides": {
            "type": "array",
            "description": "This container is used if the seller wishes to override the shipping costs or surcharge for one or more domestic or international shipping service options defined in the fulfillment listing policy. To override the costs of a specific domestic or international shipping service option, the seller must know the priority/order of that shipping service in the fulfillment listing policy. The name of a shipping service option can be found in the shippingOptions.shippingServices.shippingServiceCode field of the fulfillment policy, and the priority/order of that shipping service option is found in the shippingOptions.shippingServices.sortOrderId field. Both of these values can be retrieved by searching for that fulfillment policy with the getFulfillmentPolicies or getFulfillmentPolicyByName calls of the Account API . The shippingCostOverrides.priority value should match the shippingOptions.shippingServices.sortOrderId in order to override the shipping costs for that shipping service option. The seller must also ensure that the shippingServiceType value is set to DOMESTIC to override a domestic shipping service option, or to INTERNATIONAL to override an international shipping service option. A separate ShippingCostOverrides node is needed for each shipping service option whose costs are being overridden. All defined fields of the shippingCostOverrides container should be included, even if the shipping costs and surcharge values are not changing. The shippingCostOverrides container is returned in the getOffer and getOffers calls if one or more shipping cost overrides are being applied to the fulfillment policy.",
            "items": {
              "$ref": "#/$defs/inventory__ShippingCostOverride"
            },
            "maxItems": 10
          },
          "takeBackPolicyId": {
            "type": "string",
            "description": "This unique identifier indicates the seller-created global take-back policy that will be used once an offer is published and converted to a listing. One (1) global take-back policy may be specified per offer . Note: For countries that support country-specific policies, use regionalTakeBackPolicies to apply them to an offer.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__BestOffer": {
        "type": "object",
        "description": "This type is used by the bestOfferTerms container, which is used if the seller would like to support the Best Offer feature on their listing.",
        "properties": {
          "autoAcceptPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "autoDeclinePrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "bestOfferEnabled": {
            "type": "boolean",
            "description": "This field indicates whether or not the Best Offer feature is enabled for the listing. A seller can enable the Best Offer feature for a listing as long as the category supports the Best Offer feature. The seller includes this field and sets its value to true to enable Best Offer feature. Note: Best Offer is not available for multi-variation listings."
          }
        },
        "additionalProperties": false
      },
      "inventory__RegionalProductCompliancePolicies": {
        "type": "object",
        "description": "This type lists regional product compliance policies to be used by an offer when it is published and converted to a listing.",
        "properties": {
          "countryPolicies": {
            "type": "array",
            "description": "The array of country-specific product compliance policies to be used by an offer when it is published and converted to a listing.",
            "items": {
              "$ref": "#/$defs/inventory__CountryPolicy"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__CountryPolicy": {
        "type": "object",
        "description": "This type specifies custom product compliance and/or take-back policies that apply to a specified country.",
        "properties": {
          "country": {
            "type": "string",
            "description": "The two-letter ISO 3166-1 country code identifying the country to which the policy or policies specified in the corresponding policyIds array will apply. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "policyIds": {
            "type": "array",
            "description": "An array of custom policy identifiers that apply to the country specified by listingPolicies.regionalTakeBackPolicies.countryPolicies.country . Product compliance and take-back policy information may be returned using the following methods: getCustomPolicies Set policy_types to: PRODUCT_COMPLIANCE for product compliance policies TAKE_BACK for takeback policies This returns the list of specified policies and corresponding customPolicyId values a seller has created. getCustomPolicy with custom_policy_id = customPolicyId Returns the details of the policy specified by customPolicyId For information about creating and managing custom policies, refer to the custom_policy resource in the Sell Account API.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__RegionalTakeBackPolicies": {
        "type": "object",
        "description": "This type lists regional take-back policies to be used by an offer when it is published and converted to a listing.",
        "properties": {
          "countryPolicies": {
            "type": "array",
            "description": "The array of country-specific take-back policies to be used by an offer when it is published and converted to a listing.",
            "items": {
              "$ref": "#/$defs/inventory__CountryPolicy"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__ShippingCostOverride": {
        "type": "object",
        "description": "This type is used if the seller wants to override the shipping costs or surcharge associated with a specific domestic or international shipping service option defined in the fulfillment listing policy that is being applied toward the offer. The shipping-related costs that can be overridden include the shipping cost to ship one item, the shipping cost to ship each additional item (if multiple quantity are purchased), and the shipping surcharge applied to the shipping service option.",
        "properties": {
          "additionalShippingCost": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "priority": {
            "type": "integer",
            "description": "The integer value input into this field, along with the shippingServiceType value, sets which domestic or international shipping service option in the fulfillment policy will be modified with updated shipping costs. Specifically, the shippingCostOverrides.shippingServiceType value in a createOffer or updateOffer call must match the shippingOptions.optionType value in a fulfillment listing policy, and the shippingCostOverrides.priority value in a createOffer or updateOffer call must match the shippingOptions.shippingServices.sortOrderId value in a fulfillment listing policy. This field is always required when overriding the shipping costs of a shipping service option, and will be always be returned for each shipping service option whose costs are being overridden.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "shippingCost": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "shippingServiceType": {
            "type": "string",
            "description": "This enumerated value indicates whether the shipping service specified in the priority field is a domestic or an international shipping service option. To override the shipping costs for a specific domestic shipping service in the fulfillment listing policy, this field should be set to DOMESTIC , and to override the shipping costs for each international shipping service, this field should be set to INTERNATIONAL . This value, along with priority value, sets which domestic or international shipping service option in the fulfillment policy that will be modified with updated shipping costs. Specifically, the shippingCostOverrides.shippingServiceType value in a createOffer or updateOffer call must match the shippingOptions.optionType value in a fulfillment listing policy, and the shippingCostOverrides.priority value in a createOffer or updateOffer call must match the shippingOptions.shippingServices.sortOrderId value in a fulfillment listing policy. This field is always required when overriding the shipping costs of a shipping service option, and will be always be returned for each shipping service option whose costs are being overridden. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "surcharge": {
            "$ref": "#/$defs/inventory__Amount"
          }
        },
        "additionalProperties": false
      },
      "inventory__PricingSummary": {
        "type": "object",
        "description": "This type is used to specify the listing price for the product and settings for the Minimum Advertised Price and Strikethrough Pricing features. The price field must be supplied before an offer is published, but a seller may create an offer without supplying a price initially. The Minimum Advertised Price feature is only available on the US site. Strikethrough Pricing is available on the US, eBay Motors, UK, Germany, Canada (English and French), France, Italy, and Spain sites.",
        "properties": {
          "auctionReservePrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "auctionStartPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "minimumAdvertisedPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "originallySoldForRetailPriceOn": {
            "type": "string",
            "description": "This field is needed if the Strikethrough Pricing (STP) feature will be used in the offer. This field indicates that the product was sold for the price in the originalRetailPrice field on an eBay site, or sold for that price by a third-party retailer. When using the createOffer or updateOffer calls, the seller will pass in a value of ON_EBAY to indicate that the product was sold for the originalRetailPrice on an eBay site, or the seller will pass in a value of OFF_EBAY to indicate that the product was sold for the originalRetailPrice through a third-party retailer. This field and the originalRetailPrice field are only applicable if the seller and listing are eligible to use the Strikethrough Pricing feature, a feature which is limited to the US (core site and Motors), UK, Germany, Canada (English and French versions), France, Italy, and Spain sites. This field will be returned by getOffer and getOffers if set for the offer. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "originalRetailPrice": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "price": {
            "$ref": "#/$defs/inventory__Amount"
          },
          "pricingVisibility": {
            "type": "string",
            "description": "This field is needed if the Minimum Advertised Price (MAP) feature will be used in the offer. This field is only applicable if an eligible US seller is using the Minimum Advertised Price (MAP) feature and a minimumAdvertisedPrice has been specified. The value set in this field will determine whether the MAP price is shown to a prospective buyer prior to checkout through a pop-up window accessed from the View Item page, or if the MAP price is not shown until the checkout flow after the buyer has already committed to buying the item. To show the MAP price prior to checkout, the seller will set this value to PRE_CHECKOUT . To show the MAP price after the buyer already commits to buy the item, the seller will set this value to DURING_CHECKOUT . This field will be ignored if the seller and/or the listing is not eligible for the MAP feature. This field will be returned by getOffer and getOffers if set for the offer. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__Regulatory": {
        "type": "object",
        "description": "Type defining regulatory information that the seller is required to disclose.",
        "properties": {
          "documents": {
            "type": "array",
            "description": "This container provides a collection of regulatory documents associated with the listing. For information on removing one or more files from a listing using the updateOffer method, see Remove documents from listings. . Note: As a part of General Product Safety Regulation (GPSR) requirements effective on December 13th, 2024, sellers operating in, or shipping to, EU-based countries or Northern Ireland are conditionally required to provide regulatory document information in their eBay listings. For more information on GPSR, see General Product Safety Regulation (GPSR) .",
            "items": {
              "$ref": "#/$defs/inventory__Document"
            },
            "maxItems": 10
          },
          "energyEfficiencyLabel": {
            "$ref": "#/$defs/inventory__EnergyEfficiencyLabel"
          },
          "hazmat": {
            "$ref": "#/$defs/inventory__Hazmat"
          },
          "manufacturer": {
            "$ref": "#/$defs/inventory__Manufacturer"
          },
          "productSafety": {
            "$ref": "#/$defs/inventory__ProductSafety"
          },
          "repairScore": {
            "type": "number",
            "description": "This field represents the repair index for the listing. The repair index identifies the manufacturer's repair score for a product (i.e., how easy is it to repair the product.) This field is a floating point value between 0.0 (i.e., difficult to repair,) and 10.0 (i.e., easily repaired.) Note: 0 should not be used as a default value, as it implies the product is not repairable. The format for repairScore is limited to one decimal place. For example: 7.9 and 0.0 are both valid scores 5.645 and 2.10 are both invalid scores Note: Repair score is not applicable to all categories. Use the getExtendedProducerResponsibilityPolicies method of the Metadata API to see where repair score is applicable."
          },
          "responsiblePersons": {
            "type": "array",
            "description": "This container provides information about the EU-based Responsible Persons or entities associated with the listing. A maximum of 5 EU Responsible Persons are supported. Note: As a part of General Product Safety Regulation (GPSR) requirements effective on December 13th, 2024, sellers operating in, or shipping to, EU-based countries or Northern Ireland are conditionally required to provide regulatory Responsible Persons information in their eBay listings. For more information on GPSR, see General Product Safety Regulation (GPSR) .",
            "items": {
              "$ref": "#/$defs/inventory__ResponsiblePerson"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__Document": {
        "type": "object",
        "description": "This type provides an array of one or more regulatory documents associated with a listing for Regulatory Compliance.",
        "properties": {
          "documentId": {
            "type": "string",
            "description": "The unique identifier of a regulatory document associated with the listing. This value can be found in the response of the createDocument method of the Media API.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__EnergyEfficiencyLabel": {
        "type": "object",
        "description": "This type provides information about the energy efficiency for certain durable goods. Important! When providing energy efficiency information on an appliance or smartphones and tablets listing, the energy efficiency rating and range of the item must be specified through the the aspects field when creating the inventory item record. Use the getItemAspectsForCategory method of the Taxonomy API to retrieve applicable rating and range values for a specified category.",
        "properties": {
          "imageDescription": {
            "type": "string",
            "description": "A brief verbal summary of the information included on the Energy Efficiency Label for an item. For example, On a scale of A to G the rating is E.",
            "maxLength": 262144
          },
          "imageURL": {
            "type": "string",
            "description": "The URL to the Energy Efficiency Label image that is applicable to an item.",
            "maxLength": 262144
          },
          "productInformationSheet": {
            "type": "string",
            "description": "The URL to the Product Information Sheet that provides complete manufacturer-provided efficiency information about an item.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__Hazmat": {
        "type": "object",
        "description": "This container is used by the seller to provide hazardous material information for the listing. The statements element is required to complete the hazmat section of a listing. The following elements are optional: pictograms signalWord component",
        "properties": {
          "component": {
            "type": "string",
            "description": "This field is used by the seller to provide component information for the listing. For example, component information can provide the specific material of Hazmat concern. Max length: 120",
            "maxLength": 262144
          },
          "pictograms": {
            "type": "array",
            "description": "An array of comma-separated string values listing applicable pictogram code(s) for Hazard Pictogram(s). If your product contains hazardous substances or mixtures, please select the values corresponding to the hazard pictograms that are stated on your product's Safety Data Sheet. The selected hazard information will be displayed on your listing. Note: Use the getHazardousMaterialsLabels method in the Metadata API to find supported values for a specific marketplace/site. Refer to Pictogram sample values for additional information.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "signalWord": {
            "type": "string",
            "description": "This field sets the signal word for hazardous materials in the listing. If your product contains hazardous substances or mixtures, please select a value corresponding to the signal word that is stated on your product's Safety Data Sheet. The selected hazard information will be displayed on your listing. Note: Use the getHazardousMaterialsLabels method in the Metadata API to find supported values for a specific marketplace/site. Refer to Signal word information for additional information.",
            "maxLength": 262144
          },
          "statements": {
            "type": "array",
            "description": "An array of comma-separated string values specifying applicable statement code(s) for hazard statement(s) for the listing. If your product contains hazardous substances or mixtures, please select the values corresponding to the hazard statements that are stated on your product's Safety Data Sheet. The selected hazard information will be displayed on your listing. Note: Use the getHazardousMaterialsLabels method in the Metadata API to find supported values for a specific marketplace/site. Refer to Hazard statement sample values for additional information. This field is required if hazardous material information is provided for the listing.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__Manufacturer": {
        "type": "object",
        "description": "This type provides name and contact information about the manufacturer of the item.",
        "properties": {
          "addressLine1": {
            "type": "string",
            "description": "The first line of the product manufacturer's street address. Max length : 180 characters",
            "maxLength": 262144
          },
          "addressLine2": {
            "type": "string",
            "description": "The second line of the product manufacturer's street address. This field is not always used, but can be used for secondary address information such as 'Suite Number' or 'Apt Number'. Max length : 180 characters",
            "maxLength": 262144
          },
          "city": {
            "type": "string",
            "description": "The city of the product manufacturer's street address. Max length : 64 characters",
            "maxLength": 262144
          },
          "companyName": {
            "type": "string",
            "description": "The company name of the product manufacturer. Max length : 100 characters",
            "maxLength": 262144
          },
          "contactUrl": {
            "type": "string",
            "description": "The contact URL of the product manufacturer. Max length : 250 characters",
            "maxLength": 262144
          },
          "country": {
            "type": "string",
            "description": "This defines the list of valid country codes, adapted from http://www.iso.org/iso/country_codes, ISO 3166-1 country code. List elements take the following form to identify a two-letter code with a short name in English, a three-digit code, and a three-letter code: For example, the entry for Japan includes Japan, 392, JPN. Short codes provide uniform recognition, avoiding language-dependent country names. The number code is helpful where Latin script may be problematic. Not all listed codes are universally recognized as countries, for example: code AQ is Antarctica, 010, ATA For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "email": {
            "type": "string",
            "description": "The product manufacturer's business email address. Max length : 180 characters",
            "maxLength": 262144
          },
          "phone": {
            "type": "string",
            "description": "The product manufacturer's business phone number. Max length : 64 characters",
            "maxLength": 262144
          },
          "postalCode": {
            "type": "string",
            "description": "The postal code of the product manufacturer's street address. Max length : 9 characters",
            "maxLength": 262144
          },
          "stateOrProvince": {
            "type": "string",
            "description": "The state or province of the product manufacturer's street address. Max length : 64 characters",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__ProductSafety": {
        "type": "object",
        "description": "This type is used to define the pictograms and statement containers, and the optional component field, that provide product safety and compliance related information.",
        "properties": {
          "component": {
            "type": "string",
            "description": "This field is used by the seller to provide product safety component information for the listing. For example, component information can include specific warnings related to product safety, such as 'Tipping hazard'. Note: Component information can only be specified if used with the pictograms and/or statements field; if the component is provided without one or both of these fields, an error will occur. Max length: 120 characters",
            "maxLength": 262144
          },
          "pictograms": {
            "type": "array",
            "description": "An array of comma-separated string values used to provide product safety pictogram(s) for the listing. If your product shows universal product safety or compliance symbols, please select the values corresponding to the product safety pictograms for display in the product safety section of the listing. The seller specifies the identifier of each pictogram in this field. Note: For product safety pictograms, use the getProductSafetyLabels method of the Metadata API to find supported values for a specific marketplace/site. A maximum of 2 pictograms are allowed for product safety.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "statements": {
            "type": "array",
            "description": "An array of comma-separated string values used to provide product safety statement(s) for the listing. If your product shows universal product safety or compliance warnings, please select the values corresponding to the product safety statements for display in the product safety section of the listing. The seller specifies the identifier of each statement in this field. Note: For product safety statements, use the getProductSafetyLabels method of the Metadata API to find supported values for a specific marketplace/site. A maximum of 8 statements are allowed for product safety.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__ResponsiblePerson": {
        "type": "object",
        "description": "This type provides information, such as name and contact details, for an EU-based Responsible Person or entity, associated with the product.",
        "properties": {
          "addressLine1": {
            "type": "string",
            "description": "The first line of the Responsible Person's street address. Max length : 180 characters",
            "maxLength": 262144
          },
          "addressLine2": {
            "type": "string",
            "description": "The second line of the Responsible Person's address. This field is not always used, but can be used for secondary address information such as 'Suite Number' or 'Apt Number'. Max length : 180 characters",
            "maxLength": 262144
          },
          "city": {
            "type": "string",
            "description": "The city of the Responsible Person's street address. Max length : 64 characters",
            "maxLength": 262144
          },
          "companyName": {
            "type": "string",
            "description": "The name of the Responsible Person or entity. Max length : 100 characters",
            "maxLength": 262144
          },
          "contactUrl": {
            "type": "string",
            "description": "The contact URL of the Responsible Person or entity. Max length : 250 characters",
            "maxLength": 262144
          },
          "country": {
            "type": "string",
            "description": "This defines the list of valid country codes, adapted from http://www.iso.org/iso/country_codes, ISO 3166-1 country code. List elements take the following form to identify a two-letter code with a short name in English, a three-digit code, and a three-letter code: For example, the entry for Japan includes Japan, 392, JPN. Short codes provide uniform recognition, avoiding language-dependent country names. The number code is helpful where Latin script may be problematic. Not all listed codes are universally recognized as countries, for example: code AQ is Antarctica, 010, ATA For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "email": {
            "type": "string",
            "description": "The Responsible Person's email address. Max length : 180 characters",
            "maxLength": 262144
          },
          "phone": {
            "type": "string",
            "description": "The Responsible Person's business phone number. Max length : 64 characters",
            "maxLength": 262144
          },
          "postalCode": {
            "type": "string",
            "description": "The postal code of the Responsible Person's street address. Max length : 9 characters",
            "maxLength": 262144
          },
          "stateOrProvince": {
            "type": "string",
            "description": "The state of province of the Responsible Person's street address. Max length : 64 characters",
            "maxLength": 262144
          },
          "types": {
            "type": "array",
            "description": "The type(s) associated with the Responsible Person or entity. Note: Currently, the only supported value is EUResponsiblePerson .",
            "items": {
              "type": "string",
              "description": "For implementation help, refer to eBay API documentation",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__Tax": {
        "type": "object",
        "description": "This type is used to enable the use of a sales-tax table, to pass in a tax exception category code, or to specify a VAT percentage. Note: Sales-tax tables are available only for the US and Canada marketplaces.",
        "properties": {
          "applyTax": {
            "type": "boolean",
            "description": "When set to true , the seller's account-level sales-tax table will be used to calculate sales tax for an order. Note: Sales-tax tables are available only for the US and Canada marketplaces. Important! In the US, eBay now calculates, collects, and remits sales tax to the proper taxing authorities in all 50 states and Washington, DC. Sellers can no longer specify sales-tax rates for these jurisdictions using a tax table. However, sellers may continue to use a sales-tax table to set rates for the following US territories: American Samoa (AS) Guam (GU) Northern Mariana Islands (MP) Palau (PW) US Virgin Islands (VI) For complete information about using sales-tax tables, refer to Establishing sales-tax tables . Note that a seller can enable the use of a sales-tax table, but if a sales-tax rate is not specified for the buyer's tax jurisdiction, sales tax will not be applied to the order. When a thirdPartyTaxCategory value is used, applyTax must also be set to true . This field will be returned by getOffer and getOffers if set for the offer. For additional information, refer to Taxes and import charges ."
          },
          "thirdPartyTaxCategory": {
            "type": "string",
            "description": "The tax exception category code. If this field is used, sales tax will also apply to a service/fee, and not just the item price. This is to be used only by sellers who have opted into sales tax being calculated by a sales tax calculation vendor. If you are interested in becoming a tax calculation vendor partner with eBay, contact developer-relations@ebay.com . One supported value for this field is WASTE_RECYCLING_FEE . If this field is used, the applyTax field must also be used and set to true This field will be returned by getOffer and getOffers if set for the offer.",
            "maxLength": 262144
          },
          "vatPercentage": {
            "type": "number",
            "description": "This value is the Value Add Tax (VAT) rate for the item, if any. When a VAT percentage is specified, the item's VAT information appears on the listing's View Item page. In addition, the seller can choose to print an invoice that includes the item's net price, VAT percent, VAT amount, and total price. Since VAT rates vary depending on the item and on the user's country of residence, a seller is responsible for entering the correct VAT rate; it is not calculated by eBay. To use VAT, a seller must be a business seller with a VAT-ID registered with eBay, and must be listing the item on a VAT-enabled site. Max applicable length is 6 characters, including the decimal (e.g., 12.345). The scale is 3 decimal places. (If you pass in 12.3456, eBay may round up the value to 12.346). This field will be returned by getOffer and getOffers if set for the offer."
          }
        },
        "additionalProperties": false
      },
      "inventory__PublishByInventoryItemGroupRequest": {
        "type": "object",
        "description": "This type is used by the request payload of the publishByInventoryItemGroup call. The identifier of the inventory item group to publish and the eBay marketplace where the listing will be published is needed in the request payload.",
        "properties": {
          "inventoryItemGroupKey": {
            "type": "string",
            "description": "This is the unique identifier of the inventory item group. All unpublished offers associated with this inventory item group will be published as a multiple-variation listing if the publishByInventoryItemGroup call is successful. The inventoryItemGroupKey identifier is automatically generated by eBay once an inventory item group is created. To retrieve an inventoryItemGroupKey value, you can use the getInventoryItem method to retrieve an inventory item that is known to be in the inventory item group to publish, and then look for the inventory item group identifier under the groupIds container in the response of that call.",
            "maxLength": 262144
          },
          "marketplaceId": {
            "type": "string",
            "description": "This is the unique identifier of the eBay site on which the multiple-variation listing will be published. The marketplaceId enumeration values are found in MarketplaceEnum . For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__InventoryLocationFull": {
        "type": "object",
        "description": "This type is used by the createInventoryLocation call to provide details on the inventory location, including the location's name, physical address, operating hours, special hours, phone number and other details of an inventory location.",
        "properties": {
          "location": {
            "$ref": "#/$defs/inventory__LocationDetails"
          },
          "locationAdditionalInformation": {
            "type": "string",
            "description": "This text field is used by the merchant to provide additional information about an inventory location. Max length : 256",
            "maxLength": 262144
          },
          "locationInstructions": {
            "type": "string",
            "description": "This text field is generally used by the merchant to provide special pickup instructions for a store inventory location. Although this field is optional, it is recommended that merchants provide this field to create a pleasant and easy pickup experience for In-Store Pickup and Click and Collect orders. If this field is not included in the call request payload, eBay will use the default pickup instructions contained in the merchant's profile (if available).",
            "maxLength": 262144
          },
          "locationTypes": {
            "type": "array",
            "description": "This container is used to define the function of the inventory location. Typically, an inventory location will serve as a store, warehouse, or fulfillment center, but in some cases, an inventory location may be more than one type. For In-Store Pickup inventory, set StoreTypeEnum to STORE . To utilize the Multi-warehouse program, set StoreTypeEnum to FULFILLMENT_CENTER . If this container is omitted, the location type of the inventory location will default to WAREHOUSE . See StoreTypeEnum for the supported values. Default : WAREHOUSE",
            "items": {
              "type": "string",
              "description": "For implementation help, refer to eBay API documentation",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "locationWebUrl": {
            "type": "string",
            "description": "This text field is used by the merchant to provide the Website address (URL) associated with the inventory location. Max length : 512",
            "maxLength": 262144
          },
          "merchantLocationStatus": {
            "type": "string",
            "description": "This field is used to indicate whether the inventory location will be enabled (inventory can be loaded to location) or disabled (inventory can not be loaded to location). If this field is omitted, a successful createInventoryLocation call will automatically enable the location. A merchant may want to create a new location but leave it as disabled if the location is not yet ready for active inventory. Once the location is ready, the merchant can use the enableInventoryLocation call to enable a location that is in a disabled state. See StatusEnum for the supported values. Default : ENABLED For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "The seller-defined name of the inventory location. This name should be a human-friendly name as it will be displayed in In-Store Pickup and Click and Collect listings. A name is not required for warehouse locations. For store locations, this field is not immediately required, but will be required before an offer enabled with the In-Store Pickup or Click and Collect capability can be published. So, if the seller omits this field in a createInventoryLocation call, it becomes required for an updateInventoryLocation call. Max length : 1000",
            "maxLength": 262144
          },
          "operatingHours": {
            "type": "array",
            "description": "This container is used to express the regular operating hours for a store location during each day of the week. A dayOfWeekEnum field and an intervals container will be needed for each day of the week that the store location is open. Although not technically required, this container is highly recommended to be used to specify operating hours for a store location.",
            "items": {
              "$ref": "#/$defs/inventory__OperatingHours"
            },
            "maxItems": 10
          },
          "phone": {
            "type": "string",
            "description": "This field is used to specify the phone number for an inventory location. Max length : 36",
            "maxLength": 262144
          },
          "specialHours": {
            "type": "array",
            "description": "This container is used to express the special operating hours for a store inventory location on a specific date, such as a holiday. The special hours specified for the specific date will override the normal operating hours for that particular day of the week.",
            "items": {
              "$ref": "#/$defs/inventory__SpecialHours"
            },
            "maxItems": 10
          },
          "timeZoneId": {
            "type": "string",
            "description": "This field specifies the time zone of the inventory location being created. This value should be in Olson format (for example America/Vancouver ). For supported values, see Java Supported Zone Ids and Offsets . Note: If specified, this time zone will be used for all hour related fields. If this field is not specified for a fulfillment center location, the time zone will be calculated from the provided address fields.",
            "maxLength": 262144
          },
          "fulfillmentCenterSpecifications": {
            "$ref": "#/$defs/inventory__FulfillmentCenterSpecifications"
          }
        },
        "additionalProperties": false
      },
      "inventory__LocationDetails": {
        "type": "object",
        "description": "This type is used by the createInventoryLocation call to provide an full or partial address of an inventory location.",
        "properties": {
          "address": {
            "$ref": "#/$defs/inventory__Address"
          },
          "geoCoordinates": {
            "$ref": "#/$defs/inventory__GeoCoordinates"
          }
        },
        "additionalProperties": false
      },
      "inventory__Address": {
        "type": "object",
        "description": "This type is used to define the physical address of an inventory location.",
        "properties": {
          "addressLine1": {
            "type": "string",
            "description": "The first line of a street address. This field is required for store and fulfillment center locations. A street address is not required for warehouse locations. This field will be returned if defined for an inventory location. Max length : 128",
            "maxLength": 262144
          },
          "addressLine2": {
            "type": "string",
            "description": "The second line of a street address. This field can be used for additional address information, such as a suite or apartment number. This field will be returned if defined for an inventory location. Max length : 128",
            "maxLength": 262144
          },
          "city": {
            "type": "string",
            "description": "The city in which the inventory location resides. This field is required for store and fulfillment center locations. For warehouse locations, this field is conditionally required as part of a city and stateOrProvince pair if a postalCode is not provided. If a postalCode is provided, the city is derived from the provided postal code and this field is technically optional. This field is returned if defined for an inventory location. Max length : 128",
            "maxLength": 262144
          },
          "country": {
            "type": "string",
            "description": "The country in which the address resides, represented as two-letter ISO 3166 country code. For example, US represents the United States, and DE represents Germany. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "county": {
            "type": "string",
            "description": "The county in which the address resides. This field is returned if defined for an inventory location.",
            "maxLength": 262144
          },
          "postalCode": {
            "type": "string",
            "description": "The postal/zip code of the address. eBay uses postal codes to surface In-Store Pickup items within the vicinity of a buyer's location, and it also uses postal codes (origin and destination) to estimate shipping costs when the seller uses calculated shipping. This field is required for store and fulfillment center locations. For warehouse locations, this field is conditionally required if a city and stateOrProvince pair is not provided. Note: For warehouse locations, city and stateOrProvince pair can be used instead of a postalCode value, and then the postal code is just derived from the city and state/province. This field is returned if defined for an inventory location. Max length : 16",
            "maxLength": 262144
          },
          "stateOrProvince": {
            "type": "string",
            "description": "The state/province in which the inventory location resides. This field is required for store and fulfillment center locations. For warehouse locations, this field is conditionally required as part of a city and stateOrProvince pair if a postalCode is not provided. If a postalCode is provided, the state or province is derived from the provided zip code and this field is technically optional. Max length : 128",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__GeoCoordinates": {
        "type": "object",
        "description": "This type is used to express the Global Positioning System (GPS) latitude and longitude coordinates of an inventory location.",
        "properties": {
          "latitude": {
            "type": "number",
            "description": "The latitude (North-South) component of the geographic coordinate. This field is required if a geoCoordinates container is used. This field is returned if geographical coordinates are set for the location. Example: 33.089805"
          },
          "longitude": {
            "type": "number",
            "description": "The longitude (East-West) component of the geographic coordinate. This field is required if a geoCoordinates container is used. This field is returned if geographical coordinates are set for the location. Example: -88.709822"
          }
        },
        "additionalProperties": false
      },
      "inventory__OperatingHours": {
        "type": "object",
        "description": "This type is used to express the regular operating hours of a merchant's store or fulfillment center during the days of the week.",
        "properties": {
          "dayOfWeekEnum": {
            "type": "string",
            "description": "A dayOfWeekEnum value is required for each day of the week that the store location has regular operating hours. This field is returned if operating hours are defined for the store location. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "intervals": {
            "type": "array",
            "description": "This container is used to define the opening and closing times of a store location's working day (defined in the dayOfWeekEnum field). An intervals container is needed for each day of the week that the store location is open. If a store location closes for lunch (or any other period during the day) and then reopens, multiple open and close pairs are needed This container is returned if operating hours are defined for the store location.",
            "items": {
              "$ref": "#/$defs/inventory__Interval"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__Interval": {
        "type": "object",
        "description": "This type is used by the intervals container to define the opening and closing times of a store location's working day. Local time (in Military format) is used, with the following format: hh:mm:ss .",
        "properties": {
          "close": {
            "type": "string",
            "description": "The close value is actually the time that the store location closes. Local time (in Military format) is used. So, if a store closed at 8 PM local time, the close time would look like the following: 20:00:00 . This field is conditionally required if the intervals container is used to specify working hours or special hours for a store. This field is returned if set for the store location.",
            "maxLength": 262144
          },
          "open": {
            "type": "string",
            "description": "The open value is actually the time that the store opens. Local time (in Military format) is used. So, if a store opens at 9 AM local time, the open time would look like the following: 09:00:00 . This field is conditionally required if the intervals container is used to specify working hours or special hours for a store. This field is returned if set for the store location.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__SpecialHours": {
        "type": "object",
        "description": "This type is used to express the special operating hours of a store location on a specific date. A specialHours container is needed when the store's opening hours on a specific date are different than the normal operating hours on that particular day of the week.",
        "properties": {
          "date": {
            "type": "string",
            "description": "A date value is required for each specific date that the store location has special operating hours or is closed for that date. The timestamp is formatted as an ISO 8601 string, which is based on the 24-hour Coordinated Universal Time (UTC) clock. Format: [YYYY]-[MM]-[DD]T[hh]:[mm]:[ss].[sss]Z Example: 2025-08-04T00:00:00.000Z This field is returned if set for the store location.",
            "maxLength": 262144
          },
          "intervals": {
            "type": "array",
            "description": "This array is used to set the operating hours for the date specified in the corresponding date field. These special operating hours on this specific date will override the normal operating hours for that day of the week that is specified through the operatingHours array. To specify a location as closed on the corresponding date , include the intervals array as empty. If a location closes for lunch (or any other period during the day) and then reopens, multiple open and close pairs are needed to specify each interval where the location is open. This container is returned if set for the store location.",
            "items": {
              "$ref": "#/$defs/inventory__Interval"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__FulfillmentCenterSpecifications": {
        "type": "object",
        "description": "This type is used to provide shipping specification details, such as the weekly cut-off schedule for order handling and cut-off override(s), for a fulfillment center location.",
        "properties": {
          "sameDayShippingCutOffTimes": {
            "$ref": "#/$defs/inventory__SameDayShippingCutOffTimes"
          }
        },
        "additionalProperties": false
      },
      "inventory__SameDayShippingCutOffTimes": {
        "type": "object",
        "description": "This type is used by the createInventoryLocation call to specify cut-off time(s) for an inventory location, as well as any overrides for these times.",
        "properties": {
          "overrides": {
            "type": "array",
            "description": "This container can be used to override the existing cut-off time(s), specified in the weeklySchedule container, for a specific date or date range.",
            "items": {
              "$ref": "#/$defs/inventory__Overrides"
            },
            "maxItems": 10
          },
          "weeklySchedule": {
            "type": "array",
            "description": "This container is used to specify the weekly schedule for shipping and handling cut-off times. A cut-off time is required for each business day that the fulfillment center operates. Any orders made after the specified cutOffTime on the specified day(s) of the week will be handled on the next day.",
            "items": {
              "$ref": "#/$defs/inventory__WeeklySchedule"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__Overrides": {
        "type": "object",
        "description": "This type defines the override dates for cut-off times. This allows sellers to set special hours for their inventory location and specify different cut-off times on these days.",
        "properties": {
          "cutOffTime": {
            "type": "string",
            "description": "This field is used to override the cut-off time(s) specified in the weeklySchedule container. If an order is placed after this time in the specified date or date range, it will be handled by the seller on the following day. Format: 00:00",
            "maxLength": 262144
          },
          "endDate": {
            "type": "string",
            "description": "The end date of the cut-off time override in ISO 8601 format, which is based on the 24-hour Coordinated Universal Time (UTC) clock. Note: If the cut-off time override is only for a single day, input the same date in the startDate and endDate fields. Format: [YYYY]-[MM]-[DD] Example: 2024-08-06 Note: The time zone for this date is specified from the timeZoneId field. If this field is not used, the time zone will be derived from the provided address.",
            "maxLength": 262144
          },
          "startDate": {
            "type": "string",
            "description": "The start date of the cut-off time override in ISO 8601 format, which is based on the 24-hour Coordinated Universal Time (UTC) clock. Note: If the cut-off time override is only for a single day, input the same date in the startDate and endDate fields. Format: [YYYY]-[MM]-[DD] Example: 2024-08-04 Note: The time zone for this date is specified from the timeZoneId field. If this field is not used, the time zone will be derived from the provided address.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__WeeklySchedule": {
        "type": "object",
        "description": "This type describes the weekly schedule for cut-off times.",
        "properties": {
          "cutOffTime": {
            "type": "string",
            "description": "This field specifies the cut-off times (in 24-hour format) for the business day(s) specified in the dayOfWeekEnum array. Cut-off times default to the time zone of the specified address if the timeZoneId is not provided. Note: If cut-off hours are not specified for a particular day, the fulfillment center is considered to be on holiday for that day. Format: 00:00",
            "maxLength": 262144
          },
          "dayOfWeekEnum": {
            "type": "array",
            "description": "This comma-separated array defines the days of week for which the specified cutOffTime is used.",
            "items": {
              "type": "string",
              "description": "For implementation help, refer to eBay API documentation",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "inventory__InventoryLocation": {
        "type": "object",
        "description": "This type is used by the updateInventoryLocation call to update operating hours, special hours, phone number, and other minor details of an inventory location.",
        "properties": {
          "location": {
            "$ref": "#/$defs/inventory__LocationDetails"
          },
          "locationAdditionalInformation": {
            "type": "string",
            "description": "This text field is used by the merchant to provide/update additional information about an inventory location. Whatever text is passed in this field will replace the current text string defined for this field. If the text will not change, the same text should be passed in once again. Max length : 256",
            "maxLength": 262144
          },
          "locationInstructions": {
            "type": "string",
            "description": "This text field is generally used by the merchant to provide/update special pickup instructions for a store inventory location. Although this field is optional, it is recommended that merchants provide this field to create a pleasant and easy pickup experience for In-Store Pickup and Click and Collect orders. If this field is not included in the call request payload, eBay will use the default pickup instructions contained in the merchant's profile (if available). Whatever text is passed in this field will replace the current text string defined for this field. If the text will not change, the same text should be passed in once again. Max length : 1000",
            "maxLength": 262144
          },
          "locationTypes": {
            "type": "array",
            "description": "This container is used to update the location type(s) associated with an inventory location.",
            "items": {
              "type": "string",
              "description": "For implementation help, refer to eBay API documentation",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "locationWebUrl": {
            "type": "string",
            "description": "This text field is used by the merchant to provide/update the Website address (URL) associated with the inventory location. The URL that is passed in this field will replace any other URL that may be defined for this field. Max length : 512",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "This text field is used by the merchant to update the name of the inventory location. This name should be a human-friendly name as it will be in In-Store Pickup and Click and Collect listings. A name is not required for warehouse locations. For store locations, this field is not immediately required, but will be required before an offer enabled with the In-Store Pickup or Click and Collect capability can be published. So, if the seller omitted this field in the createInventoryLocation call, it is required for an updateInventoryLocation call. The name that is passed in this field will replace any other name that may be defined for this field.",
            "maxLength": 262144
          },
          "operatingHours": {
            "type": "array",
            "description": "This container is used to provide/update the regular operating hours for a store location during the days of the week. A dayOfWeekEnum field and an intervals container will be needed for each day of the week that the location is open. Note that if operating hours are already set for a location for a specific day of the week, whatever is set through an updateInventoryLocation call will override those existing hours.",
            "items": {
              "$ref": "#/$defs/inventory__OperatingHours"
            },
            "maxItems": 10
          },
          "phone": {
            "type": "string",
            "description": "This text field is used by the merchant to provide/update the phone number for the inventory location. The phone number that is passed in this field will replace any other phone number that may be defined for this field. Max length : 36",
            "maxLength": 262144
          },
          "specialHours": {
            "type": "array",
            "description": "This container is used to provide/update the special operating hours for a store location on a specific date, such as a holiday. The special hours specified for the specific date will override the normal operating hours for that particular day of the week. If special hours have already been set up for an inventory location, specifying special hours through an updateInventoryLocation call will only add to the list, unless the date(s) used are the same special date(s) already set up, in which case, the special hours set up through the updateInventoryLocation call will override the existing special hours.",
            "items": {
              "$ref": "#/$defs/inventory__SpecialHours"
            },
            "maxItems": 10
          },
          "timeZoneId": {
            "type": "string",
            "description": "This field is used to provide/update the time zone of the inventory location being created. This value should be in Olson format (for example America/Vancouver ). For supported values, see Java Supported Zone Ids and Offsets . Note: If specified, this time zone will be used for all hour related fields. If this field is not specified, the time zone will be calculated from the provided address fields.",
            "maxLength": 262144
          },
          "fulfillmentCenterSpecifications": {
            "$ref": "#/$defs/inventory__FulfillmentCenterSpecifications"
          }
        },
        "additionalProperties": false
      },
      "fulfillment__ShippingFulfillmentDetails": {
        "type": "object",
        "description": "This type contains the details for creating a fulfillment for an order.",
        "properties": {
          "lineItems": {
            "type": "array",
            "description": "This array contains a list of or more line items and the quantity that will be shipped in the same package.",
            "items": {
              "$ref": "#/$defs/fulfillment__LineItemReference"
            },
            "maxItems": 10
          },
          "shippedDate": {
            "type": "string",
            "description": "This is the actual date and time that the fulfillment package was shipped. This timestamp is in ISO 8601 format, which uses the 24-hour Universal Coordinated Time (UTC) clock. The seller should use the actual date/time that the package was shipped, but if this field is omitted, it will default to the current date/time. Format: [YYYY]-[MM]-[DD]T[hh]:[mm]:[ss].[sss]Z Example: 2015-08-04T19:09:02.768Z Default: The current date and time.",
            "maxLength": 262144
          },
          "shippingCarrierCode": {
            "type": "string",
            "description": "The unique identifier of the shipping carrier being used to ship the line item(s). Technically, the shippingCarrierCode and trackingNumber fields are optional, but generally these fields will be provided if the shipping carrier and tracking number are known. Note: Use the Trading API's GeteBayDetails call to retrieve the latest shipping carrier enumeration values. When making the GeteBayDetails call, include the DetailName field in the request payload and set its value to ShippingCarrierDetails . Each valid shipping carrier enumeration value is returned in a ShippingCarrierDetails.ShippingCarrier field in the response payload.",
            "maxLength": 262144
          },
          "trackingNumber": {
            "type": "string",
            "description": "The tracking number provided by the shipping carrier for this fulfillment. The seller should be careful that this tracking number is accurate since the buyer will use this tracking number to track shipment, and eBay has no way to verify the accuracy of this number. This field and the shippingCarrierCode field are mutually dependent. If you include one, you must also include the other. Note: If you include trackingNumber (and shippingCarrierCode ) in the request, the resulting fulfillment's ID (returned in the HTTP location response header) is the tracking number. If you do not include shipment tracking information, the resulting fulfillment ID will default to an arbitrary number such as 999 . Note: Only alphanumeric characters are supported for shipment tracking numbers. Spaces, hyphens, and all other special characters are not supported. Do not include a space in the tracking number even if a space appears in the tracking number on the shipping label.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "fulfillment__LineItemReference": {
        "type": "object",
        "description": "This type identifies the line item and quantity of that line item that comprises one fulfillment, such as a shipping package.",
        "properties": {
          "lineItemId": {
            "type": "string",
            "description": "This is the unique identifier of the eBay order line item that is part of the shipping fulfillment. Line item Ids can be found in the lineItems. lineItemId field of the getOrders response.",
            "maxLength": 262144
          },
          "quantity": {
            "type": "integer",
            "description": "This is the number of lineItems associated with the trackingNumber specified by the seller. This must be a whole number greater than zero (0). Default: 1",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "negotiation__CreateOffersRequest": {
        "type": "object",
        "description": "This complex type contains the fields needed to create an offer to a buyer that is initiated by the seller.",
        "properties": {
          "allowCounterOffer": {
            "type": "boolean",
            "description": "If set to true , the buyer is allowed to make a counter-offer to the seller's offer. Note: Currently, you must set this field to false ; counter-offers are not supported in this release. Default: false"
          },
          "message": {
            "type": "string",
            "description": "A seller-defined message related to the offer being made. This message is sent to the list of \"interested\" buyers. To increase the conversion rate of the offers a seller makes to buyers, eBay recommends you always add a customized message to your offers. Maximum length: 2,000 characters",
            "maxLength": 262144
          },
          "offerDuration": {
            "$ref": "#/$defs/negotiation__TimeDuration"
          },
          "offeredItems": {
            "type": "array",
            "description": "An array of objects where each object contains the details of an offer and the ID of the listing on which the offer is being made. Note that the service does not currently support the creation of multiple offers with a single call to sendOfferToInterestedBuyer . With this, each request can target only one listing at a time and you must populate this array with a single element that contains the details of one offer.",
            "items": {
              "$ref": "#/$defs/negotiation__OfferedItem"
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "negotiation__TimeDuration": {
        "type": "object",
        "description": "A complex type that specifies a period of time using a specified time-measurement unit.",
        "properties": {
          "unit": {
            "type": "string",
            "description": "A time-measurement unit that specifies a singular period of time. A span of time is defined when you apply the value specified in the value field to the value specified for unit . Time-measurement units can be YEAR, MONTH, DAY, and so on. See TimeDurationUnitEnum for a complete list of possible time-measurement units. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "value": {
            "type": "integer",
            "description": "An integer that represents an amount of time, as measured by the time-measurement unit specified in the unit field.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "negotiation__OfferedItem": {
        "type": "object",
        "description": "A complex type that defines the offer being made to an \"interested\" buyer.",
        "properties": {
          "discountPercentage": {
            "type": "string",
            "description": "This value denotes the percentage that the listing in the offer will be discounted from its original listed price. The seller can specify either the exact price of the discounted items with the price field or they can use this field to specify the percentage that the listing will be discounted, but not both. Minimum: 5 Required if you do not specify a price value.",
            "maxLength": 262144
          },
          "listingId": {
            "type": "string",
            "description": "This value is a unique eBay-assigned ID that identifies the listing to which the offer pertains. A listingId value is generated by eBay when you list an item with the Trading API. Required if you do not specify an sku value.-->",
            "maxLength": 262144
          },
          "price": {
            "$ref": "#/$defs/negotiation__Amount"
          },
          "quantity": {
            "type": "integer",
            "description": "This integer value indicates the number of items in the eBay listing for which the offer is being made. The offer being made by the seller is an \"all or nothing\" offer, meaning the buyer must purchase the indicated quantity of items in order to receive the discount on the transaction. Default: 1",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "negotiation__Amount": {
        "type": "object",
        "description": "A complex type that describes the value of a monetary amount as represented by a global currency.",
        "properties": {
          "currency": {
            "type": "string",
            "description": "The base currency applied to the value field to establish a monetary amount. The currency is represented as a 3-letter ISO4217 currency code. For example, the code for the Canadian Dollar is CAD . Default: The default currency of the eBay marketplace that hosts the listing. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          },
          "value": {
            "type": "string",
            "description": "The monetary amount in the specified currency .",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      }
    },
    "R": {
      "inventory__BulkGetInventoryItem": {
        "type": "object",
        "description": "This type is used by the base request of the bulkGetInventoryItem method.",
        "properties": {
          "requests": {
            "type": "array",
            "description": "The seller passes in multiple SKU values under this container to retrieve multiple inventory item records. Up to 25 inventory item records can be retrieved at one time.",
            "items": {
              "$ref": "#/$defs/inventory__GetInventoryItem"
            },
            "maxItems": 25,
            "minItems": 1
          }
        },
        "additionalProperties": false,
        "required": [
          "requests"
        ]
      },
      "inventory__GetInventoryItem": {
        "type": "object",
        "description": "The seller-defined Stock-Keeping Unit (SKU) of each inventory item that the user wants to retrieve is passed in the request of the bulkGetInventoryItem method.",
        "properties": {
          "sku": {
            "type": "string",
            "description": "An array of SKU values are passed in under the sku container to retrieve up to 25 inventory item records. Use the getInventoryItems method to retrieve SKU values.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "inventory__OfferKeysWithId": {
        "type": "object",
        "description": "This type is used by the base request payload of the getListingFees call.",
        "properties": {
          "offers": {
            "type": "array",
            "description": "This container is used to identify one or more (up to 250) unpublished offers for which expected listing fees will be retrieved. The user passes one or more offerId values (maximum of 250) in to this container to identify the unpublished offers in which to retrieve expected listing fees. This call is only applicable for offers in the unpublished state. The call response gives aggregate fee amounts per eBay marketplace, and does not give fee information at the individual offer level.",
            "items": {
              "$ref": "#/$defs/inventory__OfferKeyWithId"
            },
            "maxItems": 100
          }
        },
        "additionalProperties": false
      },
      "inventory__OfferKeyWithId": {
        "type": "object",
        "description": "This type is used by the getListingFees call to indicate the unpublished offer(s) for which expected listing fees will be retrieved. The user passes in one or more offerId values (a maximum of 250). See the Standard selling fees help page for more information on listing fees.",
        "properties": {
          "offerId": {
            "type": "string",
            "description": "The unique identifier of an unpublished offer for which expected listing fees will be retrieved. One to 250 offerId values can be passed in to the offers container for one getListingFees call. Use the getOffers method to retrieve offer IDs. Note: Errors will occur if offerId values representing published offers are passed in.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      }
    },
    "D": {
      "inventory__WithdrawByInventoryItemGroupRequest": {
        "type": "object",
        "description": "This type is used by the base request of the WithdrawByInventoryItemGroup method, which is used to end a multiple-variation listing.",
        "properties": {
          "inventoryItemGroupKey": {
            "type": "string",
            "description": "This is the unique identifier of the inventory item group. This identifier is automatically generated by eBay once an inventory item group is created. To retrieve an inventoryItemGroupKey value, you can use the getInventoryItem method to retrieve an inventory item that is known to be in the inventory item group to publish, and then look for the inventory item group identifier under the groupIds container in the response of that call.",
            "maxLength": 262144
          },
          "marketplaceId": {
            "type": "string",
            "description": "This is the unique identifier of the eBay site for which the offer will be made available. See MarketplaceEnum for supported values. For implementation help, refer to eBay API documentation",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      }
    }
  },
  "excluded_methods": {
    "POST /sell/account/v1/program/opt_in": "Account enrollment, identity verification or general account preferences remain outside merchant business execution.",
    "POST /sell/account/v1/program/opt_out": "Account enrollment, identity verification or general account preferences remain outside merchant business execution.",
    "GET /sell/account/v1/kyc": "Account enrollment, identity verification or general account preferences remain outside merchant business execution.",
    "GET /sell/account/v2/payout_settings": "Requires a scope or token identity outside the current three-scope seller grant.",
    "POST /sell/account/v2/payout_settings/update_percentage": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/account/v2/combined_shipping_rules": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/account/v2/user_preferences": "Requires a scope or token identity outside the current three-scope seller grant.",
    "PATCH /sell/account/v2/user_preferences": "Account enrollment, identity verification or general account preferences remain outside merchant business execution.",
    "POST /sell/fulfillment/v1/order/{order_id}/issue_refund": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/fulfillment/v1/payment_dispute/{payment_dispute_id}": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/fulfillment/v1/payment_dispute/{payment_dispute_id}/fetch_evidence_content": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/fulfillment/v1/payment_dispute/{payment_dispute_id}/activity": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/fulfillment/v1/payment_dispute_summary": "Requires a scope or token identity outside the current three-scope seller grant.",
    "POST /sell/fulfillment/v1/payment_dispute/{payment_dispute_id}/contest": "Requires a scope or token identity outside the current three-scope seller grant.",
    "POST /sell/fulfillment/v1/payment_dispute/{payment_dispute_id}/accept": "Requires a scope or token identity outside the current three-scope seller grant.",
    "POST /sell/fulfillment/v1/payment_dispute/{payment_dispute_id}/upload_evidence_file": "Requires a scope or token identity outside the current three-scope seller grant.",
    "POST /sell/fulfillment/v1/payment_dispute/{payment_dispute_id}/add_evidence": "Requires a scope or token identity outside the current three-scope seller grant.",
    "POST /sell/fulfillment/v1/payment_dispute/{payment_dispute_id}/update_evidence": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_automotive_parts_compatibility_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_category_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_classified_ad_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_currencies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_extended_producer_responsibility_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_hazardous_materials_labels": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_listing_structure_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_listing_type_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_motors_listing_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_negotiated_price_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_product_safety_labels": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_regulatory_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_return_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_shipping_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/marketplace/{marketplace_id}/get_site_visibility_policies": "Requires a scope or token identity outside the current three-scope seller grant.",
    "POST /sell/metadata/v1/compatibilities/get_compatibilities_by_specification": "Requires a scope or token identity outside the current three-scope seller grant.",
    "POST /sell/metadata/v1/compatibilities/get_compatibility_property_names": "Requires a scope or token identity outside the current three-scope seller grant.",
    "POST /sell/metadata/v1/compatibilities/get_compatibility_property_values": "Requires a scope or token identity outside the current three-scope seller grant.",
    "POST /sell/metadata/v1/compatibilities/get_multi_compatibility_property_values": "Requires a scope or token identity outside the current three-scope seller grant.",
    "POST /sell/metadata/v1/compatibilities/get_product_compatibilities": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/shipping/marketplace/{marketplace_id}/get_exclude_shipping_locations": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/shipping/marketplace/{marketplace_id}/get_handling_times": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/shipping/marketplace/{marketplace_id}/get_shipping_carriers": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/shipping/marketplace/{marketplace_id}/get_shipping_locations": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/shipping/marketplace/{marketplace_id}/get_shipping_services": "Requires a scope or token identity outside the current three-scope seller grant.",
    "GET /sell/metadata/v1/country/{countryCode}/sales_tax_jurisdiction": "Requires a scope or token identity outside the current three-scope seller grant."
  }
};
