'use strict';
// Generated from the pinned official Constant Contact specification.
module.exports = {
  "documentation_snapshot": "2026-10-01",
  "methods": {
    "GET /account/user/privileges": {
      "method": "GET",
      "path": "/account/user/privileges",
      "risk": "R",
      "scopes": [],
      "description": "GET User Privileges. One explicit page; no automatic pagination.",
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
          "$ref": "#/$defs/UserPrivilegesResource"
        }
      },
      "response_definitions": [
        "UserPrivilegesResource"
      ]
    },
    "GET /account/summary": {
      "method": "GET",
      "path": "/account/summary",
      "risk": "R",
      "scopes": [
        "account_read"
      ],
      "description": "GET a Summary of Account Details. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "extra_fields": {
                "type": "string",
                "enum": [
                  "physical_address",
                  "company_logo"
                ],
                "description": "Use the `extra_fields` query parameter to include the `physical_address` and/or `company_logo` details in the response body. Use a comma separated list to include both (physical_address, company logo).",
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
          "name": "extra_fields",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/Customer"
        }
      },
      "response_definitions": [
        "Customer",
        "CompanyLogo"
      ]
    },
    "GET /account/summary/physical_address": {
      "method": "GET",
      "path": "/account/summary/physical_address",
      "risk": "R",
      "scopes": [
        "account_read"
      ],
      "description": "GET the Physical Address for the Account. One explicit page; no automatic pagination.",
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
          "$ref": "#/$defs/AccountPhysicalAddress"
        }
      },
      "response_definitions": [
        "AccountPhysicalAddress"
      ]
    },
    "GET /account/summary/company_logo": {
      "method": "GET",
      "path": "/account/summary/company_logo",
      "risk": "R",
      "scopes": [
        "account_read"
      ],
      "description": "GET the Company Logo for the Account. One explicit page; no automatic pagination.",
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
          "$ref": "#/$defs/CompanyLogo"
        },
        "204": null
      },
      "response_definitions": [
        "CompanyLogo"
      ]
    },
    "GET /account/emails": {
      "method": "GET",
      "path": "/account/emails",
      "risk": "R",
      "scopes": [
        "account_read"
      ],
      "description": "GET a Collection of Account Email Addresses. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "confirm_status": {
                "type": "string",
                "enum": [
                  "CONFIRMED",
                  "C",
                  "UNCONFIRMED",
                  "U"
                ],
                "description": "Use the `confirm_status` query parameter to search for account emails using the email status. Possible values are `CONFIRMED` or `UNCONFIRMED`. You can also abbreviate the values of this query parameter and use `C` or `U`.",
                "maxLength": 262144
              },
              "role_code": {
                "type": "string",
                "enum": [
                  "CONTACT",
                  "C",
                  "BILLING",
                  "B",
                  "JOURNALING",
                  "J",
                  "REPLY_TO",
                  "R",
                  "OTHER",
                  "O"
                ],
                "description": "Use the `role_code` query parameter to search for account emails that have a specific role. Each each email address in an account can have multiple roles or no role. Possible values are `CONTACT`, `BILLING`, `REPLY_TO`, `JOURNALING`, or `OTHER`. You can also abbreviate the value of this query parameter and use `C`,`B`,`R`,`J`, or `O`.",
                "maxLength": 262144
              },
              "email_address": {
                "type": "string",
                "description": "Use the `email_address` query parameter to search for a specific account email address.",
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
          "name": "confirm_status",
          "location": "query",
          "explode": true
        },
        {
          "name": "role_code",
          "location": "query",
          "explode": true
        },
        {
          "name": "email_address",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/AccountEmails"
        }
      },
      "response_definitions": [
        "AccountEmails"
      ]
    },
    "GET /activities": {
      "method": "GET",
      "path": "/activities",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET Activity Status Collection. One explicit page; no automatic pagination.",
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
                "description": "Specifies the number of results displayed per page of output, from 1 - 500, default = 50.",
                "default": 50
              },
              "state": {
                "type": "string",
                "enum": [
                  "processing",
                  "completed",
                  "cancelled",
                  "failed",
                  "timed_out"
                ],
                "description": "Use this parameter to filter the response to include only activities in one of the following states: cancelled, completed, failed, processing, or timed_out.",
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
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": 50
        },
        {
          "name": "state",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/Activities"
        }
      },
      "response_definitions": [
        "Activities",
        "ActivityStatus",
        "ActivityStatusExportLink",
        "PagingLinks",
        "Link"
      ]
    },
    "GET /activities/{activity_id}": {
      "method": "GET",
      "path": "/activities/{activity_id}",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET an Activity Status. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "activity_id": {
                "type": "string",
                "description": "The unique ID of the activity to GET",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "activity_id"
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
          "name": "activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/Activity"
        }
      },
      "response_definitions": [
        "Activity",
        "ActivityStatus",
        "ActivityStatusExportLink"
      ]
    },
    "POST /activities/contact_exports": {
      "method": "POST",
      "path": "/activities/contact_exports",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "Export Contacts to a File. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/ContactsExport"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ContactsExport"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ActivityExportStatus"
        }
      },
      "response_definitions": [
        "ActivityExportStatus",
        "ActivityStatusExportLink"
      ]
    },
    "POST /activities/contact_delete": {
      "method": "POST",
      "path": "/activities/contact_delete",
      "risk": "D",
      "scopes": [
        "contact_data"
      ],
      "description": "Delete Contacts in Bulk. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/ContactDelete"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ContactDelete"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ActivityDeleteStatus"
        }
      },
      "response_definitions": [
        "ActivityDeleteStatus"
      ]
    },
    "POST /activities/contacts_json_import": {
      "method": "POST",
      "path": "/activities/contacts_json_import",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "Import Contacts using a JSON Payload. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/ContactsJsonImport"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ContactsJsonImport",
        "JsonImportContact"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ActivityImport"
        }
      },
      "response_definitions": [
        "ActivityImport",
        "ActivityStatusLink"
      ]
    },
    "POST /activities/remove_list_memberships": {
      "method": "POST",
      "path": "/activities/remove_list_memberships",
      "risk": "D",
      "scopes": [
        "contact_data"
      ],
      "description": "Remove Contacts from Lists. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/ListActivityRemoveContacts"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ListActivityRemoveContacts"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ActivityListsMembership"
        }
      },
      "response_definitions": [
        "ActivityListsMembership",
        "ActivityStatusLink"
      ]
    },
    "POST /activities/add_list_memberships": {
      "method": "POST",
      "path": "/activities/add_list_memberships",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "Add Contacts to Lists. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/ListActivityAddContacts"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ListActivityAddContacts"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ActivityListsMembership"
        }
      },
      "response_definitions": [
        "ActivityListsMembership",
        "ActivityStatusLink"
      ]
    },
    "POST /activities/list_delete": {
      "method": "POST",
      "path": "/activities/list_delete",
      "risk": "D",
      "scopes": [
        "contact_data"
      ],
      "description": "Delete Contact Lists. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/ListIdList100"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ListIdList100"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ActivityDeleteListsResponse"
        }
      },
      "response_definitions": [
        "ActivityDeleteListsResponse"
      ]
    },
    "POST /activities/contacts_taggings_remove": {
      "method": "POST",
      "path": "/activities/contacts_taggings_remove",
      "risk": "D",
      "scopes": [
        "contact_data"
      ],
      "description": "Remove Tags from Contacts. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/TagAddRemoveContacts"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "TagAddRemoveContacts"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ActivityTagging"
        }
      },
      "response_definitions": [
        "ActivityTagging",
        "ActivityTaggingStatus",
        "ActivityLinks"
      ]
    },
    "POST /activities/contacts_taggings_add": {
      "method": "POST",
      "path": "/activities/contacts_taggings_add",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "Add Tags to Contacts. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/TagAddRemoveContacts"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "TagAddRemoveContacts"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ActivityTagging"
        }
      },
      "response_definitions": [
        "ActivityTagging",
        "ActivityTaggingStatus",
        "ActivityLinks"
      ]
    },
    "POST /activities/contacts_tags_delete": {
      "method": "POST",
      "path": "/activities/contacts_tags_delete",
      "risk": "D",
      "scopes": [
        "contact_data"
      ],
      "description": "Delete Tags. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/TagIdList500Limit"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "TagIdList500Limit"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ActivityTagging"
        }
      },
      "response_definitions": [
        "ActivityTagging",
        "ActivityTaggingStatus",
        "ActivityLinks"
      ]
    },
    "POST /activities/custom_fields_delete": {
      "method": "POST",
      "path": "/activities/custom_fields_delete",
      "risk": "D",
      "scopes": [
        "contact_data"
      ],
      "description": "Delete Custom Fields. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/CustomFieldId100"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "CustomFieldId100"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ActivityDeleteCustomFields"
        }
      },
      "response_definitions": [
        "ActivityDeleteCustomFields"
      ]
    },
    "GET /events": {
      "method": "GET",
      "path": "/events",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET a collection of events.. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "event_status": {
                "type": "string",
                "description": "Use to return only events that meet the specified status. Acceptable values include `ACTIVE`,`DRAFT`, `COMPLETE`, `DELETED`,`CANCELLED`, and `ERROR`.",
                "maxLength": 262144
              },
              "search_text": {
                "type": "string",
                "description": "Use to return only events that include the specified text.",
                "maxLength": 262144
              },
              "sort_by": {
                "type": "string",
                "description": "Use to sort resulting events by one of the following properties: `name`, `start_time`, `end_time`, `created_time`, or `updated_time`.",
                "maxLength": 262144
              },
              "sort_order": {
                "type": "string",
                "description": "Sort order for the `sort_by parameter`. Accepted values include `ASC` (ascending) or `DESC` (descending). Defaults to `ASC` if `sort_by` is provided.",
                "maxLength": 262144
              },
              "limit": {
                "type": "string",
                "description": "Limit the number of results to return per page. Default and maximum is `100`.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
              },
              "prev": {
                "type": "string",
                "description": "Cursor for retrieving the previous page of results. This value is obtained from the `prev_cursor` field in a previous response.",
                "maxLength": 262144
              },
              "next": {
                "type": "string",
                "description": "Cursor for retrieving the next page of results. This value is obtained from the `next_cursor` field in a previous response.",
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
          "name": "event_status",
          "location": "query",
          "explode": true
        },
        {
          "name": "search_text",
          "location": "query",
          "explode": true
        },
        {
          "name": "sort_by",
          "location": "query",
          "explode": true
        },
        {
          "name": "sort_order",
          "location": "query",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        },
        {
          "name": "prev",
          "location": "query",
          "explode": true
        },
        {
          "name": "next",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/PaginationDtoEventListingDto"
        }
      },
      "response_definitions": [
        "PaginationDtoEventListingDto",
        "EventListingDto",
        "AddressDto",
        "EventRegistrationSummaryMetricDto",
        "Links",
        "Href"
      ]
    },
    "POST /events/default": {
      "method": "POST",
      "path": "/events/default",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "POST (create) a new event.. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Name for the new event. If not provided, a default name will be generated.",
                "maxLength": 262144
              },
              "start_time": {
                "type": "string",
                "description": "Event start time in ISO 8601 format. If not provided, defaults to a future date.",
                "maxLength": 262144
              },
              "end_time": {
                "type": "string",
                "description": "Event end time in ISO 8601 format. If not provided, defaults to one hour after start time.",
                "maxLength": 262144
              },
              "placeholder_campaign_id": {
                "type": "string",
                "description": "Placeholder campaign ID for the event.",
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
          "name": "name",
          "location": "query",
          "explode": true
        },
        {
          "name": "start_time",
          "location": "query",
          "explode": true
        },
        {
          "name": "end_time",
          "location": "query",
          "explode": true
        },
        {
          "name": "placeholder_campaign_id",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "201": {
          "$ref": "#/$defs/EventDto"
        }
      },
      "response_definitions": [
        "EventDto",
        "ContactDto",
        "AddressDto",
        "TrackDto",
        "EventMediaAssetDto",
        "PromoCodeDto",
        "ItemSummaryDto",
        "StatusDisplayLabelDto",
        "TicketSummaryDto",
        "ItemDto",
        "AttributeDto",
        "EventMetaDataDto",
        "EventPromotionDto",
        "EventSettingsDto",
        "OnlineMeetingDto"
      ]
    },
    "GET /events/{event_id}": {
      "method": "GET",
      "path": "/events/{event_id}",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET details for a single event.. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "event_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the event.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "event_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "include": {
                "type": "boolean",
                "description": "Use to include (`true`) or exclude (`false`) event setting properties in the results."
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
          "name": "event_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "include",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/EventDto"
        }
      },
      "response_definitions": [
        "EventDto",
        "ContactDto",
        "AddressDto",
        "TrackDto",
        "EventMediaAssetDto",
        "PromoCodeDto",
        "ItemSummaryDto",
        "StatusDisplayLabelDto",
        "TicketSummaryDto",
        "ItemDto",
        "AttributeDto",
        "EventMetaDataDto",
        "EventPromotionDto",
        "EventSettingsDto",
        "OnlineMeetingDto"
      ]
    },
    "PATCH /events/{event_id}": {
      "method": "PATCH",
      "path": "/events/{event_id}",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "PATCH (update) an event.. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "event_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the event to update.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "event_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/EventDto"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "EventDto",
        "ContactDto",
        "AddressDto",
        "TrackDto",
        "EventMediaAssetDto",
        "PromoCodeDto",
        "ItemSummaryDto",
        "TicketSummaryDto",
        "EventMetaDataDto",
        "EventSettingsDto",
        "OnlineMeetingDto"
      ],
      "wire": [
        {
          "name": "event_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "204": null
      },
      "response_definitions": []
    },
    "POST /events/{event_id}/copy": {
      "method": "POST",
      "path": "/events/{event_id}/copy",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "POST (copy) an existing event.. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "event_id": {
                "type": "string",
                "description": "The ID of the event to copy.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "event_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/EventCopyRequestDto"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "EventCopyRequestDto"
      ],
      "wire": [
        {
          "name": "event_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/EventDto"
        },
        "207": {
          "$ref": "#/$defs/EventDto"
        }
      },
      "response_definitions": [
        "EventDto",
        "ContactDto",
        "AddressDto",
        "TrackDto",
        "EventMediaAssetDto",
        "PromoCodeDto",
        "ItemSummaryDto",
        "StatusDisplayLabelDto",
        "TicketSummaryDto",
        "ItemDto",
        "AttributeDto",
        "EventMetaDataDto",
        "EventPromotionDto",
        "EventSettingsDto",
        "OnlineMeetingDto"
      ]
    },
    "POST /events/{event_id}/check_in/tickets": {
      "method": "POST",
      "path": "/events/{event_id}/check_in/tickets",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "Check in event tickets.. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "event_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the event.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "event_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/OrderTicketKeysRequestDto"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "OrderTicketKeysRequestDto"
      ],
      "wire": [
        {
          "name": "event_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "204": null
      },
      "response_definitions": []
    },
    "POST /events/{event_id}/undo_check_in/tickets": {
      "method": "POST",
      "path": "/events/{event_id}/undo_check_in/tickets",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "Undo event ticket check-in.. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "event_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the event.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "event_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/OrderTicketKeysRequestDto"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "OrderTicketKeysRequestDto"
      ],
      "wire": [
        {
          "name": "event_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "204": null
      },
      "response_definitions": []
    },
    "GET /events/{event_id}/tracks/{track_id}/registrations/{registration_id}": {
      "method": "GET",
      "path": "/events/{event_id}/tracks/{track_id}/registrations/{registration_id}",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "Get registration details for an event.. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "event_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the event.",
                "maxLength": 262144,
                "minLength": 1
              },
              "track_id": {
                "type": "string",
                "description": "The track key that uniquely identifies the event track.",
                "maxLength": 262144,
                "minLength": 1
              },
              "registration_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the registration.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "event_id",
              "track_id",
              "registration_id"
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
          "name": "event_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "track_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "registration_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/DetailedRegistrationDto"
        }
      },
      "response_definitions": [
        "DetailedRegistrationDto",
        "SimpleFieldDto",
        "RegistrationTicketDto",
        "OrderDetailsDto",
        "LineItemDetailsDto"
      ]
    },
    "GET /events/{event_id}/tracks/{track_id}/registrations": {
      "method": "GET",
      "path": "/events/{event_id}/tracks/{track_id}/registrations",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "Get a list of registrations for an event.. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "event_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the event.",
                "maxLength": 262144,
                "minLength": 1
              },
              "track_id": {
                "type": "string",
                "description": "The track ID that uniquely identifies the event track.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "event_id",
              "track_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "registration_status": {
                "type": "string",
                "enum": [
                  "PENDING",
                  "REGISTERED",
                  "CANCELED",
                  "EXPIRED",
                  "IN_PROGRESS, FAILED"
                ],
                "description": "Filter registration results by status.",
                "maxLength": 262144
              },
              "payment_status": {
                "type": "string",
                "enum": [
                  "PENDING",
                  "PAID",
                  "REFUNDED",
                  "CANCELLED",
                  "FAILED",
                  "CHARGED_BACK"
                ],
                "description": "Filter registration results by payment status.",
                "maxLength": 262144
              },
              "search_text": {
                "type": "string",
                "description": "Filter registration results by first name, last name, or email address.",
                "maxLength": 262144
              },
              "sort_by": {
                "type": "string",
                "enum": [
                  "first_name",
                  "last_name",
                  "email_address",
                  "registration_status",
                  "payment_status",
                  "tickets",
                  "total"
                ],
                "description": "Specify the field to use to sort the results.",
                "maxLength": 262144
              },
              "sort_order": {
                "type": "string",
                "enum": [
                  "ASC",
                  "DESC"
                ],
                "description": "Use to specify how you want the results sorted.",
                "maxLength": 262144
              },
              "page_size": {
                "type": "string",
                "description": "Alternative to the limit parameter to limit the number of results returned per page. If specifying both the limit and page_size query parameters, they must be the same value.",
                "maxLength": 262144
              },
              "limit": {
                "type": "string",
                "description": "Limit the number of results returned per page. If specifying both the limit and page_size query parameters, they must be the same value.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
              },
              "prev": {
                "type": "string",
                "description": "Cursor for pagination used to get the previous page of results (mutually exclusive with next ).",
                "maxLength": 262144
              },
              "next": {
                "type": "string",
                "description": "Cursor for pagination used to get the next page of results (mutually exclusive with prev ).",
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
          "name": "event_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "track_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "registration_status",
          "location": "query",
          "explode": true
        },
        {
          "name": "payment_status",
          "location": "query",
          "explode": true
        },
        {
          "name": "search_text",
          "location": "query",
          "explode": true
        },
        {
          "name": "sort_by",
          "location": "query",
          "explode": true
        },
        {
          "name": "sort_order",
          "location": "query",
          "explode": true
        },
        {
          "name": "page_size",
          "location": "query",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        },
        {
          "name": "prev",
          "location": "query",
          "explode": true
        },
        {
          "name": "next",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/PaginatedRegistrations"
        }
      },
      "response_definitions": [
        "PaginatedRegistrations",
        "registrations_Links",
        "Href",
        "RegistrantInformationLiteDto"
      ]
    },
    "PUT /events/{event_id}/tracks/{track_id}/registrations": {
      "method": "PUT",
      "path": "/events/{event_id}/tracks/{track_id}/registrations",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "Update status for event registrations.. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "event_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the event.",
                "maxLength": 262144,
                "minLength": 1
              },
              "track_id": {
                "type": "string",
                "description": "The track key that uniquely identifies the event track.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "event_id",
              "track_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "increase_count": {
                "type": "boolean",
                "description": "Override count flag."
              },
              "increase_item_count": {
                "type": "boolean",
                "description": "Override item count flag."
              },
              "return_items_to_inventory": {
                "type": "boolean",
                "description": "Return items to inventory flag. Defaults to `true`."
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/RegistrationStatusUpdateRequestDto"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "RegistrationStatusUpdateRequestDto"
      ],
      "wire": [
        {
          "name": "event_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "track_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "increase_count",
          "location": "query",
          "explode": true
        },
        {
          "name": "increase_item_count",
          "location": "query",
          "explode": true
        },
        {
          "name": "return_items_to_inventory",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": null,
        "207": {
          "$ref": "#/$defs/RegistrationStatusUpdateResponseDto"
        }
      },
      "response_definitions": [
        "RegistrationStatusUpdateResponseDto"
      ]
    },
    "PUT /events/{event_id}/tracks/{track_id}/registrations/payment_status": {
      "method": "PUT",
      "path": "/events/{event_id}/tracks/{track_id}/registrations/payment_status",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "Update payment status for event registrations.. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "event_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the event.",
                "maxLength": 262144,
                "minLength": 1
              },
              "track_id": {
                "type": "string",
                "description": "The track key that uniquely identifies the event track.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "event_id",
              "track_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/PaymentStatusUpdateRequestDto"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "PaymentStatusUpdateRequestDto"
      ],
      "wire": [
        {
          "name": "event_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "track_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": null,
        "207": {
          "$ref": "#/$defs/RegistrationStatusUpdateResponseDto"
        }
      },
      "response_definitions": [
        "RegistrationStatusUpdateResponseDto"
      ]
    },
    "GET /social/profiles": {
      "method": "GET",
      "path": "/social/profiles",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET social media profiles. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "include": {
                "type": "array",
                "description": "Optional sub-resources to include. Use `accessible` to check if profiles are accessible on the network.",
                "items": {
                  "type": "string",
                  "maxLength": 262144,
                  "enum": [
                    "accessible"
                  ]
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
          "name": "include",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/Profiles"
        }
      },
      "response_definitions": [
        "Profiles",
        "ProfileDto",
        "AccountInfoDto"
      ]
    },
    "GET /social/connections": {
      "method": "GET",
      "path": "/social/connections",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET social network connections. One explicit page; no automatic pagination.",
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
          "$ref": "#/$defs/ConnectionResponseDto"
        }
      },
      "response_definitions": [
        "ConnectionResponseDto",
        "ConnectionDto",
        "AccountInfoDto",
        "ConnectionStatusDto"
      ]
    },
    "GET /social/hashtags/groups": {
      "method": "GET",
      "path": "/social/hashtags/groups",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET hashtag groups. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5,
                "description": "Maximum number of hashtag groups to retrieve per page. Default and maximum is `5`.",
                "default": 5
              },
              "page": {
                "type": "integer",
                "minimum": 0,
                "description": "Page number to retrieve (0-based).",
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
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": 5
        },
        {
          "name": "page",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/PagedHashtagGroupsDto"
        }
      },
      "response_definitions": [
        "PagedHashtagGroupsDto",
        "PagedResponseLinksDto",
        "PagedResponseLinkRelDto",
        "HashtagGroupDto",
        "PageMetadataDto"
      ]
    },
    "POST /social/posts": {
      "method": "POST",
      "path": "/social/posts",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "POST (create) a social media post. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/PostCreateDto"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "PostCreateDto",
        "ProfilePostDto",
        "ImageDto",
        "ProfilePostProfileDto",
        "MapOfstringAndstring"
      ],
      "wire": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/PostDto"
        },
        "201": {
          "$ref": "#/$defs/PostDto"
        }
      },
      "response_definitions": [
        "PostDto",
        "ProfilePostDto",
        "ImageDto",
        "ProfilePostProfileDto",
        "MapOfstringAndstring"
      ]
    },
    "GET /segments": {
      "method": "GET",
      "path": "/segments",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET all Segments. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "The number of segments to return on a page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
              },
              "sort_by": {
                "type": "string",
                "description": "Specify the segment sort order to use. Sort by name (`sort_by=name`) in ascending order, or sort by date (`sort_by=date`) in descending order with the most recently updated segments listed first.",
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
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        },
        {
          "name": "sort_by",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/SegmentsDTO"
        }
      },
      "response_definitions": [
        "SegmentsDTO",
        "SegmentMaster",
        "segments_Links",
        "Next"
      ]
    },
    "POST /segments": {
      "method": "POST",
      "path": "/segments",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "POST (create) a Segment. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/SegmentData"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "SegmentData"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/SegmentDetail"
        }
      },
      "response_definitions": [
        "SegmentDetail"
      ]
    },
    "GET /segments/{segment_id}": {
      "method": "GET",
      "path": "/segments/{segment_id}",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET a Segment's Details. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "segment_id": {
                "type": "integer",
                "description": "The system-generated unique ID that identifies a segment.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "minLength": 1
              }
            },
            "required": [
              "segment_id"
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
          "name": "segment_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/SegmentDetail"
        }
      },
      "response_definitions": [
        "SegmentDetail"
      ]
    },
    "PUT /segments/{segment_id}": {
      "method": "PUT",
      "path": "/segments/{segment_id}",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "PUT (update) a Segment. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "segment_id": {
                "type": "integer",
                "description": "The system generated ID that uniquely identifies the segment that you want to modify.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "minLength": 1
              }
            },
            "required": [
              "segment_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/SegmentData"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "SegmentData"
      ],
      "wire": [
        {
          "name": "segment_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/SegmentDetail"
        }
      },
      "response_definitions": [
        "SegmentDetail"
      ]
    },
    "DELETE /segments/{segment_id}": {
      "method": "DELETE",
      "path": "/segments/{segment_id}",
      "risk": "D",
      "scopes": [
        "contact_data"
      ],
      "description": "DELETE a Segment. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "segment_id": {
                "type": "integer",
                "description": "The system generated ID that uniquely identifies the segment.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "minLength": 1
              }
            },
            "required": [
              "segment_id"
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
          "name": "segment_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "204": null
      },
      "response_definitions": []
    },
    "PATCH /segments/{segment_id}/name": {
      "method": "PATCH",
      "path": "/segments/{segment_id}/name",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "PATCH (rename) a Segment. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "segment_id": {
                "type": "integer",
                "description": "The system generated ID that uniquely identifies the segment that you want to modify.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "minLength": 1
              }
            },
            "required": [
              "segment_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/SegmentName"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "SegmentName"
      ],
      "wire": [
        {
          "name": "segment_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/SegmentDetail"
        }
      },
      "response_definitions": [
        "SegmentDetail"
      ]
    },
    "GET /contacts/{contact_id}": {
      "method": "GET",
      "path": "/contacts/{contact_id}",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET a Contact. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "contact_id": {
                "type": "string",
                "description": "Unique ID of contact to GET",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "contact_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "include": {
                "type": "string",
                "enum": [
                  "custom_fields",
                  "list_memberships",
                  "phone_numbers",
                  "street_addresses",
                  "taggings",
                  "notes"
                ],
                "description": "Use `include` to specify which contact sub-resources to include in the response. Use a comma to separate multiple sub-resources. Valid values: `custom_fields`, `list_memberships`, `phone_numbers`, `street_addresses`, `notes`, and `taggings`.",
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
          "name": "contact_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "include",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ContactResource"
        }
      },
      "response_definitions": [
        "ContactResource",
        "EmailAddress",
        "ContactCustomField",
        "PhoneNumber",
        "StreetAddress",
        "Note",
        "SmsChannelConsentDetails"
      ]
    },
    "PUT /contacts/{contact_id}": {
      "method": "PUT",
      "path": "/contacts/{contact_id}",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "PUT (update) a Contact. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "contact_id": {
                "type": "string",
                "description": "Unique ID of contact to update",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "contact_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/ContactPutRequest"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ContactPutRequest",
        "EmailAddressPut",
        "ContactCustomField",
        "PhoneNumberPut",
        "StreetAddressPut",
        "Note",
        "ContactSmsChannel",
        "ContactSmsChannelConsents"
      ],
      "wire": [
        {
          "name": "contact_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ContactResource"
        }
      },
      "response_definitions": [
        "ContactResource",
        "EmailAddress",
        "ContactCustomField",
        "PhoneNumber",
        "StreetAddress",
        "Note",
        "SmsChannelConsentDetails"
      ]
    },
    "DELETE /contacts/{contact_id}": {
      "method": "DELETE",
      "path": "/contacts/{contact_id}",
      "risk": "D",
      "scopes": [
        "contact_data"
      ],
      "description": "DELETE a Contact. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "contact_id": {
                "type": "string",
                "description": "Unique ID of contact to DELETE",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "contact_id"
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
          "name": "contact_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "204": null
      },
      "response_definitions": []
    },
    "GET /contacts": {
      "method": "GET",
      "path": "/contacts",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET Contacts Collection. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "status": {
                "type": "string",
                "enum": [
                  "all",
                  "active",
                  "deleted",
                  "not_set",
                  "pending_confirmation",
                  "temp_hold",
                  "unsubscribed"
                ],
                "description": "Use the `status` query parameter to search for contacts by status. This parameter accepts one or more comma separated values: `all`, `active`, `deleted`, `not_set`, `pending_confirmation`, `temp_hold`, and `unsubscribed`.",
                "maxLength": 262144
              },
              "email": {
                "type": "string",
                "description": "Use the `email` query parameter to search for a contact using a specific email address.",
                "maxLength": 262144
              },
              "lists": {
                "type": "string",
                "maximum": 25,
                "description": "Use the `lists` query parameter to search for contacts that are members of one or more specified lists. Use a comma to separate multiple `list_id` values, up to a maximum of 25.",
                "maxLength": 262144
              },
              "segment_id": {
                "type": "string",
                "maximum": 1,
                "description": "Use to get contacts that meet the segment criteria for a single specified `segment_id`. This query parameter can only be combined with the limit query parameter. When using the `segment_id` query parameter, the V3 API may return a 202 response code instead of a 200 response. The 202 response code indicates that your request has been accepted, but not fully completed. Retry sending your API request to return the completed results and a 200 response code.",
                "maxLength": 262144
              },
              "tags": {
                "type": "string",
                "maximum": 50,
                "description": "Use to get contact details for up to 50 specified tags. Use a comma to separate each `tag_id`.",
                "maxLength": 262144
              },
              "updated_after": {
                "type": "string",
                "description": "Use `updated_after` to search for contacts that have been updated after the date you specify. To search for updated contacts within a date range, specify both `updated_after` and `updated_before` dates. Accepts ISO-8601 formatted dates.",
                "maxLength": 262144
              },
              "updated_before": {
                "type": "string",
                "description": "Use `updated_before` to search for contacts that have been updated before a specified date. To search for updated contacts within a date range, specify both `updated_after` and `updated_before` dates. Accepts ISO-8601 formatted dates.",
                "maxLength": 262144
              },
              "created_after": {
                "type": "string",
                "description": "Use `created_after` to search for contacts created after a specified date. To search for contacts created within a date range, specify both `created_after` and `created_before` dates. Accepts ISO-8601 formatted dates.",
                "maxLength": 262144
              },
              "created_before": {
                "type": "string",
                "description": "Use `created_before` to search for contacts created before a specified date. To search for contacts created within a date range, specify both `created_after` and `created_before` dates. Accepts ISO-8601 formatted dates.",
                "maxLength": 262144
              },
              "optout_after": {
                "type": "string",
                "description": "Use `optout_after` to search for contacts that unsubscribed after a specified date.",
                "maxLength": 262144
              },
              "optout_before": {
                "type": "string",
                "description": "Use `optout_before` to search for contacts that unsubscribed before a specified date.",
                "maxLength": 262144
              },
              "include": {
                "type": "string",
                "enum": [
                  "custom_fields",
                  "list_memberships",
                  "phone_numbers",
                  "street_addresses",
                  "taggings",
                  "notes"
                ],
                "description": "Use `include` to specify which contact sub-resources to include in the response. Use a comma to separate multiple sub-resources. Valid values: `custom_fields`, `list_memberships`, `taggings`, `notes`,`phone_numbers`, `street_addresses`.",
                "maxLength": 262144
              },
              "sms_status": {
                "type": "string",
                "enum": [
                  "all",
                  "explicit",
                  "unsubscribed",
                  "pending_confirmation",
                  "not_set"
                ],
                "description": "Use to get contacts by their SMS status. This parameter accepts one or more comma separated values: `all`, `explicit`, `unsubscribed`, `pending_confirmation`, `not_set`.",
                "maxLength": 262144
              },
              "include_count": {
                "type": "boolean",
                "description": "Set `include_count=true` to include the total number of contacts (`contacts_count`) that meet all search criteria in the response body."
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Specifies the number of results displayed per page of output in the response, from 1 - 500, default = 50.",
                "default": 50
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
          "name": "status",
          "location": "query",
          "explode": true
        },
        {
          "name": "email",
          "location": "query",
          "explode": true
        },
        {
          "name": "lists",
          "location": "query",
          "explode": true
        },
        {
          "name": "segment_id",
          "location": "query",
          "explode": true
        },
        {
          "name": "tags",
          "location": "query",
          "explode": true
        },
        {
          "name": "updated_after",
          "location": "query",
          "explode": true
        },
        {
          "name": "updated_before",
          "location": "query",
          "explode": true
        },
        {
          "name": "created_after",
          "location": "query",
          "explode": true
        },
        {
          "name": "created_before",
          "location": "query",
          "explode": true
        },
        {
          "name": "optout_after",
          "location": "query",
          "explode": true
        },
        {
          "name": "optout_before",
          "location": "query",
          "explode": true
        },
        {
          "name": "include",
          "location": "query",
          "explode": true
        },
        {
          "name": "sms_status",
          "location": "query",
          "explode": true
        },
        {
          "name": "include_count",
          "location": "query",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": 50
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/Contacts"
        },
        "202": {
          "$ref": "#/$defs/Contacts"
        }
      },
      "response_definitions": [
        "Contacts",
        "ContactResource",
        "EmailAddress",
        "ContactCustomField",
        "PhoneNumber",
        "StreetAddress",
        "Note",
        "SmsChannelConsentDetails",
        "PagingLinks",
        "Link"
      ]
    },
    "POST /contacts": {
      "method": "POST",
      "path": "/contacts",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "POST (create) a Contact. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/ContactPostRequest"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ContactPostRequest",
        "EmailAddressPost",
        "ContactCustomField",
        "PhoneNumberPut",
        "StreetAddressPut",
        "Note",
        "ContactSmsChannel",
        "ContactSmsChannelConsents"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ContactResource"
        }
      },
      "response_definitions": [
        "ContactResource",
        "EmailAddress",
        "ContactCustomField",
        "PhoneNumber",
        "StreetAddress",
        "Note",
        "SmsChannelConsentDetails"
      ]
    },
    "POST /contacts/sign_up_form": {
      "method": "POST",
      "path": "/contacts/sign_up_form",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "Create or Update a Contact. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/ContactCreateOrUpdateInput"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ContactCreateOrUpdateInput",
        "CreateOrUpdateContactCustomField",
        "JmmlSmsChannel",
        "JmmlSmsChannelConsents"
      ],
      "wire": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/ContactCreateOrUpdateResponse"
        },
        "201": {
          "$ref": "#/$defs/ContactCreateOrUpdateResponse"
        }
      },
      "response_definitions": [
        "ContactCreateOrUpdateResponse"
      ]
    },
    "GET /contacts/contact_id_xrefs": {
      "method": "GET",
      "path": "/contacts/contact_id_xrefs",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET a collection of V2 and V3 API contact IDs. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "sequence_ids": {
                "type": "string",
                "maxItems": 500,
                "description": "Comma delimited list of V2 API contact `ids` to cross-reference with the V3 API `contact_id` value. Endpoint accepts a maximum of 500 ids at a time.",
                "maxLength": 262144
              }
            },
            "required": [
              "sequence_ids"
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
          "name": "sequence_ids",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ContactXrefs"
        }
      },
      "response_definitions": [
        "ContactXrefs",
        "ContactXref"
      ]
    },
    "GET /contact_custom_fields/{custom_field_id}": {
      "method": "GET",
      "path": "/contact_custom_fields/{custom_field_id}",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET a custom_field. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "custom_field_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the custom field.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "custom_field_id"
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
          "name": "custom_field_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/CustomField"
        }
      },
      "response_definitions": [
        "CustomField",
        "CustomFieldMetadata",
        "CustomFieldChoice"
      ]
    },
    "PUT /contact_custom_fields/{custom_field_id}": {
      "method": "PUT",
      "path": "/contact_custom_fields/{custom_field_id}",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "Update a custom field.. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "custom_field_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the custom field to update.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "custom_field_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/CustomFieldPutRequest"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "CustomFieldPutRequest",
        "CustomFieldChoicePutRequest"
      ],
      "wire": [
        {
          "name": "custom_field_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/CustomField"
        }
      },
      "response_definitions": [
        "CustomField",
        "CustomFieldMetadata",
        "CustomFieldChoice"
      ]
    },
    "DELETE /contact_custom_fields/{custom_field_id}": {
      "method": "DELETE",
      "path": "/contact_custom_fields/{custom_field_id}",
      "risk": "D",
      "scopes": [
        "contact_data"
      ],
      "description": "DELETE a custom_field. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "custom_field_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the custom field to delete.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "custom_field_id"
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
          "name": "custom_field_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "204": null
      },
      "response_definitions": []
    },
    "GET /contact_custom_fields": {
      "method": "GET",
      "path": "/contact_custom_fields",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET custom_fields Collection. One explicit page; no automatic pagination.",
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
                "description": "Specifies the number of results displayed per page of output, from 1 - 100, default = 50.",
                "default": 50
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
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": 50
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/CustomFields"
        }
      },
      "response_definitions": [
        "CustomFields",
        "CustomField",
        "CustomFieldMetadata",
        "CustomFieldChoice",
        "PagingLinks",
        "Link"
      ]
    },
    "POST /contact_custom_fields": {
      "method": "POST",
      "path": "/contact_custom_fields",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "POST (create) a custom_field. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/CustomFieldRequest"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "CustomFieldRequest",
        "CustomFieldMetadata",
        "CustomFieldChoiceRequest"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/CustomField"
        }
      },
      "response_definitions": [
        "CustomField",
        "CustomFieldMetadata",
        "CustomFieldChoice"
      ]
    },
    "GET /contact_lists/{list_id}": {
      "method": "GET",
      "path": "/contact_lists/{list_id}",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET a List. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "list_id": {
                "type": "string",
                "description": "The system generated ID that uniquely identifies a contact list.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "list_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "include_membership_count": {
                "type": "string",
                "enum": [
                  "all",
                  "active"
                ],
                "description": "Returns the total number of contacts per list that meet your selection criteria. Set the `include_membership_count` to `active`, to count only active contacts, or `all` to include all contacts in the count.",
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
          "name": "list_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "include_membership_count",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ContactList"
        }
      },
      "response_definitions": [
        "ContactList"
      ]
    },
    "PUT /contact_lists/{list_id}": {
      "method": "PUT",
      "path": "/contact_lists/{list_id}",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "PUT (update) a List. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "list_id": {
                "type": "string",
                "description": "Unique ID of the contact list to update",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "list_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/ListInput"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ListInput"
      ],
      "wire": [
        {
          "name": "list_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ContactListPutPost"
        }
      },
      "response_definitions": [
        "ContactListPutPost"
      ]
    },
    "DELETE /contact_lists/{list_id}": {
      "method": "DELETE",
      "path": "/contact_lists/{list_id}",
      "risk": "D",
      "scopes": [
        "contact_data"
      ],
      "description": "DELETE a List. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "list_id": {
                "type": "string",
                "description": "Unique ID of the list to delete",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "list_id"
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
          "name": "list_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "202": {
          "$ref": "#/$defs/ActivityDeleteListResponse"
        }
      },
      "response_definitions": [
        "ActivityDeleteListResponse"
      ]
    },
    "GET /contact_lists": {
      "method": "GET",
      "path": "/contact_lists",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET Lists Collection. One explicit page; no automatic pagination.",
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
                "description": "Use to specify the number of results displayed per page of output, from 1 - 500, default = 50.",
                "default": 50
              },
              "include_count": {
                "type": "boolean",
                "description": "Set `include_count` to `true` to return the total number of contact lists that meet your selection criteria."
              },
              "include_membership_count": {
                "type": "string",
                "enum": [
                  "all",
                  "active"
                ],
                "description": "Use to include the total number of contacts per list. Set to `active`, to count only active (mailable) contacts, or `all` to count all contacts.",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "description": "Use to get details for a single list by entering the full name of the list.",
                "maxLength": 262144
              },
              "status": {
                "type": "string",
                "enum": [
                  "all",
                  "active",
                  "deleted"
                ],
                "description": "Use to get lists by status. Accepts comma-separated status values.",
                "maxLength": 262144
              },
              "channel_type": {
                "type": "string",
                "enum": [
                  "email",
                  "sms"
                ],
                "description": "Use to return lists by channel type. The default value is `email`.",
                "maxLength": 262144
              },
              "include_sms_membership_count": {
                "type": "boolean",
                "description": "Set to `true` to return the total number of SMS members in each list. Only applicable when `channel_type` is `sms`. Default is `false`."
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
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": 50
        },
        {
          "name": "include_count",
          "location": "query",
          "explode": true
        },
        {
          "name": "include_membership_count",
          "location": "query",
          "explode": true
        },
        {
          "name": "name",
          "location": "query",
          "explode": true
        },
        {
          "name": "status",
          "location": "query",
          "explode": true
        },
        {
          "name": "channel_type",
          "location": "query",
          "explode": true
        },
        {
          "name": "include_sms_membership_count",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ContactListArray"
        }
      },
      "response_definitions": [
        "ContactListArray",
        "ContactList",
        "PagingLinks",
        "Link"
      ]
    },
    "POST /contact_lists": {
      "method": "POST",
      "path": "/contact_lists",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "POST (create) a List. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/ListInput"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ListInput"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/ContactListPutPost"
        }
      },
      "response_definitions": [
        "ContactListPutPost"
      ]
    },
    "GET /contact_lists/list_id_xrefs": {
      "method": "GET",
      "path": "/contact_lists/list_id_xrefs",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET a collection of V2 and V3 API List IDs. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "sequence_ids": {
                "type": "string",
                "maxItems": 500,
                "description": "Comma delimited list of V2 API list `ids` to cross-reference with the V3 API `list_id` value. Endpoint accepts a maximum of 500 ids at a time.",
                "maxLength": 262144
              }
            },
            "required": [
              "sequence_ids"
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
          "name": "sequence_ids",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ListXrefs"
        }
      },
      "response_definitions": [
        "ListXrefs",
        "ListXref"
      ]
    },
    "GET /contacts/sms_engagement_history/{contact_id}": {
      "method": "GET",
      "path": "/contacts/sms_engagement_history/{contact_id}",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET SMS Engagement History for a Contact. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "contact_id": {
                "type": "string",
                "description": "The contact's unique ID.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "contact_id"
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
          "name": "contact_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/SmsEngagementHistory"
        }
      },
      "response_definitions": [
        "SmsEngagementHistory",
        "HistoryDetails"
      ]
    },
    "GET /contacts/counts": {
      "method": "GET",
      "path": "/contacts/counts",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET Contact Consent Counts. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "include": {
                "type": "string",
                "enum": [
                  "new_subscriber"
                ],
                "description": "Use to return the total number of contacts that subscribed within the last 30 days in the results.",
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
          "name": "include",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ContactsCounts"
        }
      },
      "response_definitions": [
        "ContactsCounts"
      ]
    },
    "PUT /contacts/resubscribe/{contact_id}": {
      "method": "PUT",
      "path": "/contacts/resubscribe/{contact_id}",
      "risk": "H",
      "scopes": [
        "contact_data"
      ],
      "description": "PUT Resubscribe a Contact. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "contact_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the contact to resubscribe.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "contact_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/ContactResubscribeRequest"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ContactResubscribeRequest"
      ],
      "wire": [
        {
          "name": "contact_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": null
      },
      "response_definitions": []
    },
    "GET /contact_tags/{tag_id}": {
      "method": "GET",
      "path": "/contact_tags/{tag_id}",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET Tag Details. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "tag_id": {
                "type": "string",
                "description": "The ID that uniquely identifies a tag (UUID format).",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "tag_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "include_count": {
                "type": "boolean",
                "description": "Use to include (`true`) or exclude (`false`) the total number of tagged contacts (`contacts_count`) from the results."
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
          "name": "tag_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "include_count",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/Tag"
        }
      },
      "response_definitions": [
        "Tag"
      ]
    },
    "PUT /contact_tags/{tag_id}": {
      "method": "PUT",
      "path": "/contact_tags/{tag_id}",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "PUT (Update) a Tag. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "tag_id": {
                "type": "string",
                "description": "The system generated ID used to uniquely identify the tag that you want to rename (UUID format).",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "tag_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/TagPut"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "TagPut"
      ],
      "wire": [
        {
          "name": "tag_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/Tag"
        }
      },
      "response_definitions": [
        "Tag"
      ]
    },
    "DELETE /contact_tags/{tag_id}": {
      "method": "DELETE",
      "path": "/contact_tags/{tag_id}",
      "risk": "D",
      "scopes": [
        "contact_data"
      ],
      "description": "DELETE a Tag. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "tag_id": {
                "type": "string",
                "description": "The ID that uniquely identifies a tag in UUID format.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "tag_id"
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
          "name": "tag_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "202": {
          "$ref": "#/$defs/ActivityGeneric"
        }
      },
      "response_definitions": [
        "ActivityGeneric",
        "ActivityErrors",
        "ActivityGenericStatus",
        "tags_ActivityLinks"
      ]
    },
    "GET /contact_tags": {
      "method": "GET",
      "path": "/contact_tags",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET Details for All Tags. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "description": "Use to specify the number of tag results (up to `500`) to display per page of output. The default is `50`.",
                "minimum": 1,
                "maximum": 100,
                "default": 50
              },
              "include_count": {
                "type": "boolean",
                "description": "Returns the total number of contacts (`contacts_count`) to which a tag applies."
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
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": 50
        },
        {
          "name": "include_count",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/Tags"
        }
      },
      "response_definitions": [
        "Tags",
        "Tag",
        "tags_PagingLinks",
        "tags_Links",
        "reporting_Next"
      ]
    },
    "POST /contact_tags": {
      "method": "POST",
      "path": "/contact_tags",
      "risk": "W",
      "scopes": [
        "contact_data"
      ],
      "description": "POST (Create) a Tag. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/TagPost"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "TagPost"
      ],
      "wire": [],
      "responses": {
        "201": {
          "$ref": "#/$defs/Tag"
        }
      },
      "response_definitions": [
        "Tag"
      ]
    },
    "GET /emails": {
      "method": "GET",
      "path": "/emails",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET a Collection of Email Campaigns. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "description": "Specifies the number of campaigns to display on each page of output that is returned (from return 1 - 500). The default returns 50 campaigns per page.",
                "minimum": 1,
                "maximum": 100,
                "default": 50
              },
              "before_date": {
                "type": "string",
                "description": "Use to return email campaigns with `updated_at` timestamps that are before a specific date and time (in ISO-8601 format). Use with the `after_date` query parameter to get email campaigns sent within a specific date range.",
                "maxLength": 262144
              },
              "after_date": {
                "type": "string",
                "description": "Use to return email campaigns with last `updated_at` timestamps that are after a specific date and time (in ISO-8601 format). Use with the `before_date` query parameter to get email campaigns sent within a specific date range.",
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
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": 50
        },
        {
          "name": "before_date",
          "location": "query",
          "explode": true
        },
        {
          "name": "after_date",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/PagedEmailCampaignResponse"
        }
      },
      "response_definitions": [
        "PagedEmailCampaignResponse",
        "emails_PagingLinks",
        "emails_Link",
        "EmailCampaigns"
      ]
    },
    "POST /emails": {
      "method": "POST",
      "path": "/emails",
      "risk": "W",
      "scopes": [
        "campaign_data"
      ],
      "description": "POST (Create) a New Email Campaign. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "$ref": "#/$defs/EmailCampaignComplete"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "EmailCampaignComplete",
        "EmailCampaignActivityInput",
        "EmailPhysicalAddress"
      ],
      "wire": [],
      "responses": {
        "200": {
          "$ref": "#/$defs/EmailCampaign"
        }
      },
      "response_definitions": [
        "EmailCampaign",
        "ActivityReference"
      ]
    },
    "GET /emails/{campaign_id}": {
      "method": "GET",
      "path": "/emails/{campaign_id}",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET Details About a Single Email Campaign. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_id": {
                "type": "string",
                "description": "The ID (UUID format) that uniquely identifies this email campaign.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_id"
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
          "name": "campaign_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/EmailCampaign"
        }
      },
      "response_definitions": [
        "EmailCampaign",
        "ActivityReference"
      ]
    },
    "DELETE /emails/{campaign_id}": {
      "method": "DELETE",
      "path": "/emails/{campaign_id}",
      "risk": "D",
      "scopes": [
        "campaign_data"
      ],
      "description": "DELETE an Email Campaign. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_id": {
                "type": "string",
                "description": "The unique ID for the email campaign you are deleting.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_id"
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
          "name": "campaign_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "204": null
      },
      "response_definitions": []
    },
    "PATCH /emails/{campaign_id}": {
      "method": "PATCH",
      "path": "/emails/{campaign_id}",
      "risk": "W",
      "scopes": [
        "campaign_data"
      ],
      "description": "PATCH (Update) an Email Campaign Name. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_id": {
                "type": "string",
                "description": "The unique identifier for an email campaign.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/EmailCampaignName"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "EmailCampaignName"
      ],
      "wire": [
        {
          "name": "campaign_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/EmailCampaign"
        }
      },
      "response_definitions": [
        "EmailCampaign",
        "ActivityReference"
      ]
    },
    "GET /emails/campaign_id_xrefs": {
      "method": "GET",
      "path": "/emails/campaign_id_xrefs",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET a Collection of V2 and V3 API Email Campaign Identifiers. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "v2_email_campaign_ids": {
                "type": "string",
                "maxItems": 50,
                "description": "Comma separated list of V2 API `campaignId` values. You can enter up to 50 V2 `campaignId` values in each request.",
                "maxLength": 262144
              }
            },
            "required": [
              "v2_email_campaign_ids"
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
          "name": "v2_email_campaign_ids",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/CrossReferenceResponse"
        }
      },
      "response_definitions": [
        "CrossReferenceResponse",
        "CrossReference"
      ]
    },
    "GET /emails/activities/{campaign_activity_id}": {
      "method": "GET",
      "path": "/emails/activities/{campaign_activity_id}",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET a Single Email Campaign Activity. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for an email campaign activity.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "include": {
                "type": "string",
                "enum": [
                  "physical_address_in_footer",
                  "permalink_url",
                  "html_content",
                  "document_properties"
                ],
                "description": "Use the `include` query parameter to enter a comma separated list of additional email campaign activity properties for the V3 API to return. Valid values are `physical_address_in_footer`, `permalink_url`, `html_content`, and `document_properties`.",
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "include",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/EmailCampaignActivity"
        }
      },
      "response_definitions": [
        "EmailCampaignActivity",
        "EmailPhysicalAddress"
      ]
    },
    "PUT /emails/activities/{campaign_activity_id}": {
      "method": "PUT",
      "path": "/emails/activities/{campaign_activity_id}",
      "risk": "W",
      "scopes": [
        "campaign_data"
      ],
      "description": "PUT (Update) An Email Campaign Activity. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for the email campaign activity you are updating.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/EmailCampaignActivity"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "EmailCampaignActivity",
        "EmailPhysicalAddress"
      ],
      "wire": [
        {
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/EmailCampaignActivity"
        }
      },
      "response_definitions": [
        "EmailCampaignActivity",
        "EmailPhysicalAddress"
      ]
    },
    "GET /emails/activities/{campaign_activity_id}/schedules": {
      "method": "GET",
      "path": "/emails/activities/{campaign_activity_id}/schedules",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Campaign Activity Schedule. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for an email campaign activity.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/EmailScheduleResponse"
        }
      },
      "response_definitions": [
        "EmailScheduleResponse"
      ]
    },
    "POST /emails/activities/{campaign_activity_id}/schedules": {
      "method": "POST",
      "path": "/emails/activities/{campaign_activity_id}/schedules",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "POST (Create) an Email Campaign Activity Schedule. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for an email campaign activity. You can only schedule email campaign activities that have the `primary_email` role.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/EmailScheduleInput"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "EmailScheduleInput"
      ],
      "wire": [
        {
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "201": {
          "$ref": "#/$defs/EmailScheduleResponse"
        }
      },
      "response_definitions": [
        "EmailScheduleResponse"
      ]
    },
    "DELETE /emails/activities/{campaign_activity_id}/schedules": {
      "method": "DELETE",
      "path": "/emails/activities/{campaign_activity_id}/schedules",
      "risk": "D",
      "scopes": [
        "campaign_data"
      ],
      "description": "DELETE an Email Campaign Activity Schedule. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for an email campaign activity.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "204": null
      },
      "response_definitions": []
    },
    "POST /emails/activities/{campaign_activity_id}/tests": {
      "method": "POST",
      "path": "/emails/activities/{campaign_activity_id}/tests",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "POST Test Send an Email Campaign Activity. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for an email campaign activity. You can only test send email campaign activities that have the `primary_email` role.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/EmailTestSendInput"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "EmailTestSendInput"
      ],
      "wire": [
        {
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "204": null
      },
      "response_definitions": []
    },
    "GET /emails/activities/{campaign_activity_id}/previews": {
      "method": "GET",
      "path": "/emails/activities/{campaign_activity_id}/previews",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET the HTML Preview of an Email Campaign Activity. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for an email campaign activity.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/EmailCampaignActivityPreview"
        }
      },
      "response_definitions": [
        "EmailCampaignActivityPreview"
      ]
    },
    "GET /emails/activities/{campaign_activity_id}/send_history": {
      "method": "GET",
      "path": "/emails/activities/{campaign_activity_id}/send_history",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET the Send History of an Email Campaign Activity. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for an email campaign activity. You can return the send history for `primary_email` and `resend` role email campaign activities.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/EmailSendHistory"
        }
      },
      "response_definitions": [
        "EmailSendHistory"
      ]
    },
    "GET /emails/activities/{campaign_activity_id}/non_opener_resends": {
      "method": "GET",
      "path": "/emails/activities/{campaign_activity_id}/non_opener_resends",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET Details for a Resend to Non-openers Campaign Activity. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for the primary email campaign activity.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ResendToNonOpeners"
        }
      },
      "response_definitions": [
        "ResendToNonOpeners"
      ]
    },
    "POST /emails/activities/{campaign_activity_id}/non_opener_resends": {
      "method": "POST",
      "path": "/emails/activities/{campaign_activity_id}/non_opener_resends",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "POST a Resend to Non-openers Campaign Activity. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for the primary email campaign activity.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/ResendToNonOpenersInput"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ResendToNonOpenersInput"
      ],
      "wire": [
        {
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "201": {
          "$ref": "#/$defs/ResendToNonOpenersObject"
        }
      },
      "response_definitions": [
        "ResendToNonOpenersObject"
      ]
    },
    "DELETE /emails/activities/{campaign_activity_id}/non_opener_resends/{resend_request_id}": {
      "method": "DELETE",
      "path": "/emails/activities/{campaign_activity_id}/non_opener_resends/{resend_request_id}",
      "risk": "D",
      "scopes": [
        "campaign_data"
      ],
      "description": "DELETE a Resend to Non Openers Activity. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for the primary email campaign activity.",
                "maxLength": 262144,
                "minLength": 1
              },
              "resend_request_id": {
                "type": "string",
                "description": "The unique ID associated with the resend for the email campaign activity (for example: `389093`). If the email campaign activity is currently in draft status, specify `DRAFT` as the ID.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id",
              "resend_request_id"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "resend_request_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "204": null
      },
      "response_definitions": []
    },
    "GET /automations/workflows": {
      "method": "GET",
      "path": "/automations/workflows",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "List All Automations. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "channel": {
                "type": "string",
                "description": "Filter by channel",
                "maxLength": 262144
              },
              "sort_direction": {
                "type": "string",
                "enum": [
                  "ASC",
                  "DESC"
                ],
                "description": "Sort direction, ASC or DESC. Defaults to DESC",
                "maxLength": 262144
              },
              "created_from": {
                "type": "string",
                "enum": [
                  "SCRATCH",
                  "TEMPLATE"
                ],
                "description": "Filter by how the workflow was created",
                "maxLength": 262144
              },
              "goals": {
                "type": "string",
                "description": "Filter by goal tags (e.g. post_purchase_followup, up_sell_and_cross_sell)",
                "maxLength": 262144
              },
              "name": {
                "type": "string",
                "description": "Find by workflow name (exact match)",
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
          "name": "channel",
          "location": "query",
          "explode": true
        },
        {
          "name": "sort_direction",
          "location": "query",
          "explode": true
        },
        {
          "name": "created_from",
          "location": "query",
          "explode": true
        },
        {
          "name": "goals",
          "location": "query",
          "explode": true
        },
        {
          "name": "name",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "209": {
          "$ref": "#/$defs/ListAutomationFlowsResponseDto"
        }
      },
      "response_definitions": [
        "ListAutomationFlowsResponseDto",
        "AutomationFlowSummaryDto",
        "StructuredTagDto"
      ]
    },
    "POST /automations/workflows": {
      "method": "POST",
      "path": "/automations/workflows",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "Create an Automation. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "workflowName": {
                "type": "string",
                "description": "Use this query parameter to provide a workflow name and override the default name.",
                "maxLength": 262144
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/TriggerDefDto"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "TriggerDefDto",
        "ParameterDto"
      ],
      "wire": [
        {
          "name": "workflowName",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "201": {
          "$ref": "#/$defs/AutomationCampaign"
        }
      },
      "response_definitions": [
        "AutomationCampaign",
        "AutomationStructuredTag",
        "AutomationWorkflowDefinition",
        "TriggerDto",
        "TriggerDefDto",
        "ParameterDto",
        "TriggerFilterDto",
        "TriggerFilterRuleDto",
        "PropertyComparisonDto",
        "AutomationFlow",
        "AutomationWorkflowDef",
        "WorkflowParametersDto",
        "CorrelationMetadataDto",
        "TaskDto",
        "TaskCorrelationMetadataDto",
        "TimeoutDto"
      ]
    },
    "GET /automations/workflows/{automation_flow_id}": {
      "method": "GET",
      "path": "/automations/workflows/{automation_flow_id}",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "Retrieve an Automation. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "automation_flow_id": {
                "type": "string",
                "description": "Automation workflow identifier.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "automation_flow_id"
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
          "name": "automation_flow_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/AutomationCampaign"
        }
      },
      "response_definitions": [
        "AutomationCampaign",
        "AutomationStructuredTag",
        "AutomationWorkflowDefinition",
        "TriggerDto",
        "TriggerDefDto",
        "ParameterDto",
        "TriggerFilterDto",
        "TriggerFilterRuleDto",
        "PropertyComparisonDto",
        "AutomationFlow",
        "AutomationWorkflowDef",
        "WorkflowParametersDto",
        "CorrelationMetadataDto",
        "TaskDto",
        "TaskCorrelationMetadataDto",
        "TimeoutDto"
      ]
    },
    "PUT /automations/workflows/{automation_flow_id}": {
      "method": "PUT",
      "path": "/automations/workflows/{automation_flow_id}",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "Update an Automation. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "automation_flow_id": {
                "type": "string",
                "description": "Automation workflow identifier.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "automation_flow_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/AutomationCampaignUpdate"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "AutomationCampaignUpdate",
        "AutomationCampaign",
        "AutomationStructuredTag",
        "AutomationWorkflowDefinition",
        "TriggerDto",
        "TriggerDefDto",
        "ParameterDto",
        "TriggerFilterDto",
        "TriggerFilterRuleDto",
        "PropertyComparisonDto",
        "AutomationFlow",
        "AutomationWorkflowDef",
        "WorkflowParametersDto",
        "CorrelationMetadataDto",
        "TaskDto",
        "TaskCorrelationMetadataDto",
        "TimeoutDto"
      ],
      "wire": [
        {
          "name": "automation_flow_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/AutomationCampaign"
        }
      },
      "response_definitions": [
        "AutomationCampaign",
        "AutomationStructuredTag",
        "AutomationWorkflowDefinition",
        "TriggerDto",
        "TriggerDefDto",
        "ParameterDto",
        "TriggerFilterDto",
        "TriggerFilterRuleDto",
        "PropertyComparisonDto",
        "AutomationFlow",
        "AutomationWorkflowDef",
        "WorkflowParametersDto",
        "CorrelationMetadataDto",
        "TaskDto",
        "TaskCorrelationMetadataDto",
        "TimeoutDto"
      ]
    },
    "GET /emails/activities/{campaign_activity_id}/abtest": {
      "method": "GET",
      "path": "/emails/activities/{campaign_activity_id}/abtest",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET A/B Test Details for an Email Campaign Activity. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for the primary email campaign activity.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ABTestData"
        }
      },
      "response_definitions": [
        "ABTestData"
      ]
    },
    "POST /emails/activities/{campaign_activity_id}/abtest": {
      "method": "POST",
      "path": "/emails/activities/{campaign_activity_id}/abtest",
      "risk": "H",
      "scopes": [
        "campaign_data"
      ],
      "description": "POST (Create) an A/B Test for an Email Campaign Activity. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for the primary email campaign activity.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "body": {
            "$ref": "#/$defs/ABTestData"
          }
        },
        "required": [
          "path",
          "body"
        ],
        "additionalProperties": false
      },
      "input_definitions": [
        "ABTestData"
      ],
      "wire": [
        {
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "201": {
          "$ref": "#/$defs/ABTestData"
        }
      },
      "response_definitions": [
        "ABTestData"
      ]
    },
    "DELETE /emails/activities/{campaign_activity_id}/abtest": {
      "method": "DELETE",
      "path": "/emails/activities/{campaign_activity_id}/abtest",
      "risk": "D",
      "scopes": [
        "campaign_data"
      ],
      "description": "DELETE an A/B Test for an Email Campaign Activity. Acknowledgement only; inspect state before retrying an uncertain write.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for the primary email campaign activity.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "204": null
      },
      "response_definitions": []
    },
    "GET /reports/contact_reports/{contact_id}/activity_details": {
      "method": "GET",
      "path": "/reports/contact_reports/{contact_id}/activity_details",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET Contact Activity Details. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "contact_id": {
                "type": "string",
                "description": "The contact's ID for which tracking activity data is requested.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "contact_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "tracking_activities_list": {
                "type": "string",
                "description": "Specify one or more tracking activity types to include as a comma-delimited string. The `tracking_activities_list` and `tracking_activities_type` query parameters are mutually exclusive.",
                "items": {
                  "type": "string",
                  "enum": [
                    "em_sends",
                    "em_opens",
                    "em_clicks",
                    "em_bounces",
                    "em_optouts",
                    "em_forwards",
                    "p_contact_open",
                    "p_contact_click",
                    "p_contact_add",
                    "p_contact_update"
                  ],
                  "maxLength": 262144
                },
                "maxItems": 100,
                "maxLength": 262144
              },
              "tracking_activity_type": {
                "type": "array",
                "description": "Specify one or more tracking activity types to include as an array. The `tracking_activities_list` and `tracking_activities_type` query parameters are mutually exclusive.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "include_campaign_activity_names": {
                "type": "boolean",
                "description": "Default (`true`) returns campaign activity names in the results. Not including campaign activity names in the results (`false`), is more efficient."
              },
              "limit": {
                "type": "string",
                "minimum": 1,
                "maximum": 100,
                "description": "The number of tracking activities to return in a single page. Valid values are 1 to 100. Default is 100.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
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
          "name": "contact_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "tracking_activities_list",
          "location": "query",
          "explode": true
        },
        {
          "name": "tracking_activity_type",
          "location": "query",
          "explode": true
        },
        {
          "name": "include_campaign_activity_names",
          "location": "query",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ContactTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "ContactTrackingActivitiesPage",
        "ContactTrackingActivity",
        "reporting_Links",
        "reporting_Next"
      ]
    },
    "GET /reports/contact_reports/{contact_id}/open_and_click_rates": {
      "method": "GET",
      "path": "/reports/contact_reports/{contact_id}/open_and_click_rates",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET Average Open and Click Rates. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "contact_id": {
                "type": "string",
                "description": "The contact id which is requesting tracking activity data (e.g. aa9ff7b0-478d-11e6-8059-00163e3c8e19)",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "contact_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "start": {
                "type": "string",
                "description": "The starting date, in ISO 8601 format, to use to get campaigns. For example: 2019-01-01T00:00:00-0500.",
                "maxLength": 262144
              },
              "end": {
                "type": "string",
                "description": "The ending date, in ISO 8601 format, to use to get campaigns. For example: 2019-12-01T00:00:00-0500.",
                "maxLength": 262144
              }
            },
            "required": [
              "start",
              "end"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "query"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "name": "contact_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "start",
          "location": "query",
          "explode": true
        },
        {
          "name": "end",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ContactOpenAndClickRates"
        }
      },
      "response_definitions": [
        "ContactOpenAndClickRates"
      ]
    },
    "GET /reports/contact_reports/{contact_id}/activity_summary": {
      "method": "GET",
      "path": "/reports/contact_reports/{contact_id}/activity_summary",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET Contact Action Summary. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "contact_id": {
                "type": "string",
                "description": "The contact id which is requesting tracking activity data (e.g. aa9ff7b0-478d-11e6-8059-00163e3c8e19)",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "contact_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "start": {
                "type": "string",
                "description": "The starting date, in ISO 8601 format, to use to get campaigns. For example: 2019-01-01T00:00:00-0500.",
                "maxLength": 262144
              },
              "end": {
                "type": "string",
                "description": "The ending date, in ISO 8601 format, to use to get campaigns. For example: 2019-12-01T00:00:00-0500.",
                "maxLength": 262144
              }
            },
            "required": [
              "start",
              "end"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path",
          "query"
        ],
        "additionalProperties": false
      },
      "input_definitions": [],
      "wire": [
        {
          "name": "contact_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "start",
          "location": "query",
          "explode": true
        },
        {
          "name": "end",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ContactCampaignActivitiesSummary"
        }
      },
      "response_definitions": [
        "ContactCampaignActivitiesSummary",
        "CampaignActivitySummary",
        "reporting_Links",
        "reporting_Next"
      ]
    },
    "GET /reports/email_reports/{campaign_activity_id}/links": {
      "method": "GET",
      "path": "/reports/email_reports/{campaign_activity_id}/links",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Links Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for an email campaign activity.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "no_clicks": {
                "type": "boolean",
                "description": "Set this query parameter to `true` to return details for links that were not clicked in the response results."
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "no_clicks",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/EmailLinks"
        }
      },
      "response_definitions": [
        "EmailLinks",
        "EmailLinkClickCount"
      ]
    },
    "GET /reports/email_reports/{campaign_activity_id}/tracking/sends": {
      "method": "GET",
      "path": "/reports/email_reports/{campaign_activity_id}/tracking/sends",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Sends Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for an email campaign activity to use for this report.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "minimum": 1,
                "maximum": 500,
                "description": "The number of tracking activities to return on a page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/SendsTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "SendsTrackingActivitiesPage",
        "SendsTrackingActivity",
        "reporting_Links",
        "reporting_Next"
      ]
    },
    "GET /reports/email_reports/{campaign_activity_id}/tracking/opens": {
      "method": "GET",
      "path": "/reports/email_reports/{campaign_activity_id}/tracking/opens",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Opens Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The unique ID for an email campaign activity to use for this report.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "minimum": 1,
                "maximum": 500,
                "description": "The number of tracking activities to return on a page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/OpensTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "OpensTrackingActivitiesPage",
        "OpensTrackingActivity",
        "reporting_Links",
        "reporting_Next"
      ]
    },
    "GET /reports/email_reports/{campaign_activity_id}/tracking/unique_opens": {
      "method": "GET",
      "path": "/reports/email_reports/{campaign_activity_id}/tracking/unique_opens",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Unique Opens Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the email campaign activity to use for this report.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "minimum": 1,
                "maximum": 500,
                "description": "The number of tracking activities to return on a page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/OpensTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "OpensTrackingActivitiesPage",
        "OpensTrackingActivity",
        "reporting_Links",
        "reporting_Next"
      ]
    },
    "GET /reports/email_reports/{campaign_activity_id}/tracking/didnotopens": {
      "method": "GET",
      "path": "/reports/email_reports/{campaign_activity_id}/tracking/didnotopens",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Did Not Opens Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the email campaign activity to use for this report.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "minimum": 1,
                "maximum": 500,
                "description": "The number of tracking activities to return on a page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/DidNotOpensTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "DidNotOpensTrackingActivitiesPage",
        "DidNotOpensTrackingActivity",
        "reporting_Links",
        "reporting_Next"
      ]
    },
    "GET /reports/email_reports/{campaign_activity_id}/tracking/clicks": {
      "method": "GET",
      "path": "/reports/email_reports/{campaign_activity_id}/tracking/clicks",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Clicks Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the email campaign activity to use for this report.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "url_id": {
                "type": "integer",
                "description": "The ID that uniquely identifies a single link URL for which you want to get a clicks report.",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "limit": {
                "type": "string",
                "minimum": 1,
                "maximum": 500,
                "description": "The number of tracking activities to return on a page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "url_id",
          "location": "query",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ClicksTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "ClicksTrackingActivitiesPage",
        "ClicksTrackingActivity",
        "reporting_Links",
        "reporting_Next"
      ]
    },
    "GET /reports/email_reports/{campaign_activity_id}/tracking/forwards": {
      "method": "GET",
      "path": "/reports/email_reports/{campaign_activity_id}/tracking/forwards",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Forwards Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the email campaign activity to use for this report.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "minimum": 1,
                "maximum": 500,
                "description": "The number of tracking activities to return on a page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/ForwardsTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "ForwardsTrackingActivitiesPage",
        "ForwardsTrackingActivity",
        "reporting_Links",
        "reporting_Next"
      ]
    },
    "GET /reports/email_reports/{campaign_activity_id}/tracking/optouts": {
      "method": "GET",
      "path": "/reports/email_reports/{campaign_activity_id}/tracking/optouts",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Opt-outs Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the email campaign activity to use for this report.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "minimum": 1,
                "maximum": 500,
                "description": "The number of tracking activities to return on a page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/OptoutsTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "OptoutsTrackingActivitiesPage",
        "OptoutsTrackingActivity",
        "reporting_Links",
        "reporting_Next"
      ]
    },
    "GET /reports/email_reports/{campaign_activity_id}/tracking/bounces": {
      "method": "GET",
      "path": "/reports/email_reports/{campaign_activity_id}/tracking/bounces",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Bounces Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The ID that uniquely identifies the email campaign activity to use for this report.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "bounce_code": {
                "type": "array",
                "description": "To return results for a specific bounce code, select the `bounce_code` from the drop-down list. To return results for multiple codes, repeat the bounce code parameter for each. For example, to return results for bounce codes `B` and `D` use `bounce_code=B&bounce_code=D`.",
                "items": {
                  "type": "string",
                  "enum": [
                    "B",
                    "D",
                    "F",
                    "S",
                    "V",
                    "X",
                    "Z"
                  ],
                  "maxLength": 262144
                },
                "maxItems": 100
              },
              "limit": {
                "type": "string",
                "minimum": 1,
                "maximum": 500,
                "description": "The number of tracking activities to return on a page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "100"
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "bounce_code",
          "location": "query",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "100"
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/BouncesTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "BouncesTrackingActivitiesPage",
        "BouncesTrackingActivity",
        "reporting_Links",
        "reporting_Next"
      ]
    },
    "GET /reports/email_reports/campaign_performance": {
      "method": "GET",
      "path": "/reports/email_reports/campaign_performance",
      "risk": "R",
      "scopes": [
        "contact_data"
      ],
      "description": "GET Campaign Performance Statistics. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "start_at": {
                "type": "string",
                "description": "The date range start in ISO 8601 format (e.g. '2016-01-27T21:56:37.011Z')",
                "maxLength": 262144
              },
              "end_at": {
                "type": "string",
                "description": "The date range end in ISO 8601 format (e.g. '2016-01-27T21:56:37.011Z')",
                "maxLength": 262144
              },
              "count": {
                "type": "string",
                "description": "Number of campaign stats to return in a single request.",
                "maxLength": 262144
              },
              "filter": {
                "type": "string",
                "description": "Filter campaigns by adjusted_timestamp (default) or start_at.",
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
          "name": "start_at",
          "location": "query",
          "explode": true
        },
        {
          "name": "end_at",
          "location": "query",
          "explode": true
        },
        {
          "name": "count",
          "location": "query",
          "explode": true
        },
        {
          "name": "filter",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/CampaignPerformanceStatsQueryResult"
        }
      },
      "response_definitions": [
        "CampaignPerformanceStatsQueryResult",
        "StatsError",
        "CampaignPerformanceStatsResult",
        "CampaignPerformanceStats"
      ]
    },
    "GET /reports/summary_reports/email_campaign_summaries": {
      "method": "GET",
      "path": "/reports/summary_reports/email_campaign_summaries",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Campaigns Summary Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "Use the `limit` query parameter to limit the number of email campaign summaries to return on a single page. The default is `50` and the maximum is `500` per page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "50"
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
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "50"
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/BulkEmailCampaignSummariesPage"
        }
      },
      "response_definitions": [
        "BulkEmailCampaignSummariesPage",
        "BulkEmailCampaignSummary",
        "UniqueEmailCounts",
        "BulkEmailCampaignSummariesPercents",
        "reporting_Links",
        "reporting_Next"
      ]
    },
    "GET /reports/stats/email_campaigns/{campaign_ids}": {
      "method": "GET",
      "path": "/reports/stats/email_campaigns/{campaign_ids}",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Campaign Stats Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_ids": {
                "type": "string",
                "maximum": 150,
                "description": "A comma-separated list of `campaign_id`s (UUID's).",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_ids"
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
          "name": "campaign_ids",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/CampaignStatsQueryResultEmail"
        }
      },
      "response_definitions": [
        "CampaignStatsQueryResultEmail",
        "StatsError",
        "CampaignStatsResultGenericStatsEmailPercentsEmail",
        "StatsEmail",
        "PercentsEmail"
      ]
    },
    "GET /reports/stats/email_campaign_activities/{campaign_activity_ids}": {
      "method": "GET",
      "path": "/reports/stats/email_campaign_activities/{campaign_activity_ids}",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an Email Campaign Activity Stats Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_ids": {
                "type": "string",
                "maximum": 10,
                "description": "A comma-separated list of `campaign_activity_id`s (UUID's).",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_ids"
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
          "name": "campaign_activity_ids",
          "location": "path",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/CampaignActivityStatsQueryResultEmail"
        }
      },
      "response_definitions": [
        "CampaignActivityStatsQueryResultEmail",
        "StatsError",
        "CampaignActivityStatsResultGenericStatsEmailActivity",
        "StatsEmailActivity"
      ]
    },
    "GET /reports/landing_pages/campaign_details/{campaign_activity_id}/p_unique_contact_clicks": {
      "method": "GET",
      "path": "/reports/landing_pages/campaign_details/{campaign_activity_id}/p_unique_contact_clicks",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET a Unique Contacts Clicks Landing Page Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The landing page `campaign_activity_id` (UUID's) to use to get unique contact click results.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "Use to limit the number of contact tracking activities to return on a single page. The default is `50` and the maximum is `500` per page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "50"
              },
              "contacts_filter": {
                "type": "string",
                "description": "Use to filter the results to return only contacts that match a contacts full or partial first or last name, or email. For example: Josie or Jo.",
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "50"
        },
        {
          "name": "contacts_filter",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/PContactClickTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "PContactClickTrackingActivitiesPage",
        "PContactClickTrackingActivity",
        "TrackingActivitySmsChannelDTO",
        "lp_reporting_Links",
        "lp_reporting_Next"
      ]
    },
    "GET /reports/landing_pages/campaign_details/{campaign_activity_id}/p_unique_contact_opens": {
      "method": "GET",
      "path": "/reports/landing_pages/campaign_details/{campaign_activity_id}/p_unique_contact_opens",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET a Unique Contacts Opens Landing Page Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The landing page `campaign_activity_id` (UUID's) to use to get unique contact open results.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "Use to limit the number of contact tracking activities to return on a single page. The default is `50` and the maximum is `500` per page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "50"
              },
              "contacts_filter": {
                "type": "string",
                "description": "Use to filter the results to only include contacts that contain a certain value. This parameter does full and partial matches and applies to the contact first name, last name, and email fields. For example: Josie or Jo.",
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "50"
        },
        {
          "name": "contacts_filter",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/PContactOpensTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "PContactOpensTrackingActivitiesPage",
        "PContactOpenTrackingActivity",
        "TrackingActivitySmsChannelDTO",
        "lp_reporting_Links",
        "lp_reporting_Next"
      ]
    },
    "GET /reports/landing_pages/campaign_details/{campaign_activity_id}/p_contact_opens": {
      "method": "GET",
      "path": "/reports/landing_pages/campaign_details/{campaign_activity_id}/p_contact_opens",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET a Contacts Opens Landing Page Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The landing page `campaign_activity_id` (UUID's) to use to get unique contact open results.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "Use to limit the number of contact tracking activities to return on a single page. The default is `50` and the maximum is `500` per page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "50"
              },
              "contacts_filter": {
                "type": "string",
                "description": "Use to filter the results to only include contacts that contain a certain value. This parameter does full and partial matches and applies to the contact first name, last name, and email fields. For example: Josie or Jo.",
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "50"
        },
        {
          "name": "contacts_filter",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/PContactOpensTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "PContactOpensTrackingActivitiesPage",
        "PContactOpenTrackingActivity",
        "TrackingActivitySmsChannelDTO",
        "lp_reporting_Links",
        "lp_reporting_Next"
      ]
    },
    "GET /reports/landing_pages/campaign_details/{campaign_activity_id}/p_unique_contact_updates": {
      "method": "GET",
      "path": "/reports/landing_pages/campaign_details/{campaign_activity_id}/p_unique_contact_updates",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET a Unique Contacts Updates Landing Page Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The landing page `campaign_activity_id` (UUID's) to use to get unique contact open results.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "Use to limit the number of contact tracking activities to return on a single page. The default is `50` and the maximum is `500` per page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "50"
              },
              "contacts_filter": {
                "type": "string",
                "description": "Use to filter the results to only include contacts that contain a certain value. This parameter does full and partial matches and applies to the contact first name, last name, and email fields. For example: Josie or Jo.",
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "50"
        },
        {
          "name": "contacts_filter",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/PContactUpdateTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "PContactUpdateTrackingActivitiesPage",
        "PContactUpdateTrackingActivity",
        "TrackingActivitySmsChannelDTO",
        "lp_reporting_Links",
        "lp_reporting_Next"
      ]
    },
    "GET /reports/landing_pages/campaign_details/{campaign_activity_id}/p_unique_contact_adds": {
      "method": "GET",
      "path": "/reports/landing_pages/campaign_details/{campaign_activity_id}/p_unique_contact_adds",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET a Unique Contacts Adds Landing Page Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The landing page `campaign_activity_id` (UUID's) to use to get unique contact results.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "Use to limit the number of contact tracking activities to return on a single page. The default is `50` and the maximum is `500` per page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "50"
              },
              "contacts_filter": {
                "type": "string",
                "description": "Use to filter the results to only include contacts that contain a certain value. This parameter does full and partial matches and applies to the contact first name, last name, and email fields. For example: Josie or Jo.",
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "50"
        },
        {
          "name": "contacts_filter",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/PContactAddTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "PContactAddTrackingActivitiesPage",
        "PContactAddTrackingActivity",
        "TrackingActivitySmsChannelDTO",
        "lp_reporting_Links",
        "lp_reporting_Next"
      ]
    },
    "GET /reports/landing_pages/campaign_details/{campaign_activity_id}/p_unique_contact_sms_optins": {
      "method": "GET",
      "path": "/reports/landing_pages/campaign_details/{campaign_activity_id}/p_unique_contact_sms_optins",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET a Unique Contacts SMS Opt-In Landing Page Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "campaign_activity_id": {
                "type": "string",
                "description": "The landing page `campaign_activity_id` (UUID's) to use to get unique contact click results.",
                "maxLength": 262144,
                "minLength": 1
              }
            },
            "required": [
              "campaign_activity_id"
            ],
            "additionalProperties": false
          },
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "Use to limit the number of contact tracking activities to return on a single page. The default is `50` and the maximum is `500` per page.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-9][0-9]|100)$",
                "default": "50"
              },
              "contacts_filter": {
                "type": "string",
                "description": "Use to filter the results to return only contacts that match a contacts full or partial first or last name, or email. For example: Josie or Jo.",
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
          "name": "campaign_activity_id",
          "location": "path",
          "explode": true
        },
        {
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "50"
        },
        {
          "name": "contacts_filter",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/PContactSMSOptInTrackingActivitiesPage"
        }
      },
      "response_definitions": [
        "PContactSMSOptInTrackingActivitiesPage",
        "PContactSMSOptInTrackingActivity",
        "TrackingActivitySmsChannelDTO",
        "lp_reporting_Links",
        "lp_reporting_Next"
      ]
    },
    "GET /reports/summary_reports/sms_campaign_summaries": {
      "method": "GET",
      "path": "/reports/summary_reports/sms_campaign_summaries",
      "risk": "R",
      "scopes": [
        "campaign_data"
      ],
      "description": "GET an SMS Campaigns Summary Report. One explicit page; no automatic pagination.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "string",
                "description": "Use to limit the number of results to return on a single page (from 1 to 50). The default setting is 50.",
                "maxLength": 262144,
                "pattern": "^(?:[1-9]|[1-4][0-9]|50)$",
                "default": "50"
              },
              "start_at": {
                "type": "string",
                "description": "Use to limit the results to include SMS campaign summary details for SMS campaigns sent on or after the required `start_at` date you specify. ISO 8601 format.",
                "maxLength": 262144
              },
              "end_at": {
                "type": "string",
                "description": "Use to limit the results to include SMS campaign summary details for SMS campaigns sent on or before the `end_at` date you specify. ISO 8601 format.",
                "maxLength": 262144
              }
            },
            "required": [
              "start_at"
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
          "name": "limit",
          "location": "query",
          "explode": true,
          "default": "50"
        },
        {
          "name": "start_at",
          "location": "query",
          "explode": true
        },
        {
          "name": "end_at",
          "location": "query",
          "explode": true
        }
      ],
      "responses": {
        "200": {
          "$ref": "#/$defs/SmsCampaignSummariesPage"
        }
      },
      "response_definitions": [
        "SmsCampaignSummariesPage",
        "BulkCampaignSummary",
        "UniqueSmsCounts",
        "BulkSmsCampaignSummariesPercents",
        "reporting_sms_Links",
        "reporting_sms_Next"
      ]
    }
  },
  "definitions": {
    "R": {},
    "W": {
      "ContactsExport": {
        "type": "object",
        "description": "Export contact objects to a CSV file. By default, all contacts in the user's account are exported unless a filtering parameter is specified.",
        "properties": {
          "contact_ids": {
            "type": "array",
            "maxItems": 25,
            "description": "Exports up to 500 specific contacts. This property is mutually exclusive with all other filtering criteria except with status .",
            "items": {
              "type": "string",
              "maxLength": 262144
            }
          },
          "list_ids": {
            "type": "array",
            "maxItems": 25,
            "description": "Exports all of the contacts inside of up to 50 contact lists. This property is mutually exclusive with all other filtering criteria except with either status or exclude .",
            "items": {
              "type": "string",
              "maxLength": 262144
            }
          },
          "tag_ids": {
            "type": "array",
            "maxItems": 25,
            "description": "Exports contacts assigned one or more of the tags ( tag_id ) specified. This property is mutually exclusive with all other filtering criteria.",
            "items": {
              "type": "string",
              "maxLength": 262144
            }
          },
          "new_subscriber": {
            "type": "boolean",
            "description": "Set to true to only export contacts that subscribed within the last 30 days. Default setting is false . This property is mutually exclusive with all other filtering criteria except with either list_ids or exclude ."
          },
          "segment_id": {
            "type": "integer",
            "description": "Specify the segment_id from which you want to export all contacts that meet the specified segment_criteria . You can only specify one segment_id . This property is mutually exclusive with all other filtering criteria.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "fields": {
            "type": "array",
            "description": "By default , all fields are returned. Use this array to only export specific contact fields. You must export email_address to successfully export email_optin_source , email_optin_date , email_optout_source , email_optout_date , or email_optout_reason .",
            "items": {
              "type": "string",
              "enum": [
                "first_name",
                "last_name",
                "contact_id",
                "email_address",
                "email_lists",
                "phone_number",
                "company_name",
                "job_title",
                "social_profiles",
                "website",
                "tag",
                "notes",
                "street",
                "street_1",
                "street_2",
                "city",
                "state",
                "intl_state",
                "zip",
                "country",
                "anniversary",
                "birthday",
                "birthday_day",
                "birthday_month",
                "source_name",
                "created_at",
                "updated_at",
                "email_optin",
                "email_permission",
                "email_update_source",
                "email_optin_source",
                "email_optin_date",
                "email_optout_date",
                "email_optout_source",
                "email_optout_reason",
                "sms_number",
                "sms_consent_date",
                "sms_status"
              ],
              "maxLength": 262144
            },
            "maxItems": 25
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "unsubscribed",
              "removed"
            ],
            "description": "Allows you to export only contacts that have a specific status value. This property is mutually exclusive with all other filtering criteria except with either contact_ids or list_ids .",
            "maxLength": 262144
          },
          "exclude": {
            "type": "object",
            "properties": {
              "contact_ids": {
                "type": "array",
                "description": "Excludes up to 50 specified contacts ( contact_id ) from being exported. This property is mutually exclusive with all other filtering criteria except with either list_ids or new_subscriber .",
                "items": {
                  "type": "string",
                  "description": "An array of contact_id s to exclude.",
                  "maxLength": 262144
                },
                "maxItems": 25
              }
            },
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      },
      "ContactsJsonImport": {
        "type": "object",
        "required": [
          "import_data",
          "list_ids"
        ],
        "properties": {
          "import_data": {
            "type": "array",
            "description": "An array containing the contacts to import.",
            "items": {
              "$ref": "#/$defs/JsonImportContact"
            },
            "maxItems": 25
          },
          "list_ids": {
            "type": "array",
            "minItems": 1,
            "maxItems": 25,
            "description": "Specify which contact lists you are adding all imported contacts to as an array of up to 50 contact list_id string values.",
            "items": {
              "type": "string",
              "maxLength": 262144
            }
          },
          "sms_permission_to_send": {
            "type": "string",
            "enum": [
              "explicit",
              "not_set"
            ],
            "description": "Specifies if the contact gave explicit SMS permission or if the SMS permission was not set ( not_set ). If `explicit, the sms_consent_date must be provided.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "JsonImportContact": {
        "type": "object",
        "properties": {
          "email": {
            "type": "string",
            "maxLength": 50,
            "description": "The email address of the contact. This method identifies each unique contact using their email address. Required if `sms_number` is not specified."
          },
          "first_name": {
            "type": "string",
            "maxLength": 50,
            "description": "The first name of the contact."
          },
          "last_name": {
            "type": "string",
            "maxLength": 50,
            "description": "The last name of the contact."
          },
          "job_title": {
            "type": "string",
            "maxLength": 50,
            "description": "The job title of the contact."
          },
          "company_name": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the company where the contact works."
          },
          "birthday_month": {
            "type": "integer",
            "description": "The month value for the contact's birthday. Valid values are from 1 through 12. The birthday_month property is required if you use birthday_day .",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "birthday_day": {
            "type": "integer",
            "description": "The day value for the contact's birthday. Valid values are from 1 through 31. The birthday_day property is required if you use birthday_month .",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "anniversary": {
            "type": "string",
            "description": "The anniversary date for the contact. For example, this value could be the date when the contact first became a customer of an organization in Constant Contact. Valid date formats are MM/DD/YYYY, M/D/YYYY, YYYY/MM/DD, YYYY/M/D, YYYY-MM-DD, YYYY-M-D,M-D-YYYY, or M-DD-YYYY.",
            "maxLength": 262144
          },
          "phone": {
            "type": "string",
            "maxLength": 50,
            "description": "The primary phone number for the contact. Use this field to add the default kind of phone number to the imported contact's phone number. Default kind is other ."
          },
          "home_phone": {
            "type": "string",
            "maxLength": 50,
            "description": "The home phone number for the contact."
          },
          "work_phone": {
            "type": "string",
            "maxLength": 50,
            "description": "The work phone number for the contact."
          },
          "mobile_phone": {
            "type": "string",
            "maxLength": 50,
            "description": "The mobile phone number for the contact."
          },
          "other_phone": {
            "type": "string",
            "maxLength": 50,
            "description": "A phone number for the contact."
          },
          "street": {
            "type": "string",
            "maxLength": 255,
            "description": "Line one of the primary street address for the contact. Use this field to add the default kind of street to the imported contact's street address. The default kind is home . which maps to the street_addresses array` in the response."
          },
          "street2": {
            "type": "string",
            "maxLength": 255,
            "description": "Line two of the primary street address for the contact. This value is automatically appended to the street value. Use this field to add the default kind for line two of the street address to the imported contact's address. The default kind is other ."
          },
          "city": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the primary city for the contact. Use this field to add the default kind of city to the imported contact's home address. The default kind is home ."
          },
          "state": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the primary state or province for the contact. Use this field to add the default kind of state to the imported contact's home address. The default kind is home ."
          },
          "zip": {
            "type": "string",
            "maxLength": 50,
            "description": "The zip or postal code associated with the contact's primary address. Use this field to add the default kind of zip to the imported contact's street address. The default kind is home ."
          },
          "country": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the primary country where the contact is located. Use this field to add the default kind of country to the imported contact's street address. The default kind is home ."
          },
          "home_street": {
            "type": "string",
            "maxLength": 255,
            "description": "Line one of the home street address for the contact."
          },
          "home_street2": {
            "type": "string",
            "maxLength": 255,
            "description": "Line two of the home street address for the contact. This value is automatically appended to the home_street value."
          },
          "home_city": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the city where the contact lives."
          },
          "home_state": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the home state or province where the contact lives."
          },
          "home_zip": {
            "type": "string",
            "maxLength": 50,
            "description": "The zip or postal code associated with the contact's home address."
          },
          "home country": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the country where the contact lives."
          },
          "work_street": {
            "type": "string",
            "maxLength": 255,
            "description": "Line one of the work street address for the contact."
          },
          "work_street2": {
            "type": "string",
            "maxLength": 255,
            "description": "Line two of the work street address for the contact. This value is automatically appended to the work_street value."
          },
          "work_city": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the city where the contact works."
          },
          "work_state": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the state or province where the contact works."
          },
          "work_zip": {
            "type": "string",
            "maxLength": 50,
            "description": "The zip or postal code associated with the contact's work address."
          },
          "work_country": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the country where the contact works."
          },
          "other_street": {
            "type": "string",
            "maxLength": 255,
            "description": "Line one of the other street address for the contact."
          },
          "other_street2": {
            "type": "string",
            "maxLength": 255,
            "description": "Line two of the other street address for the contact. This value is automatically appended to the other_street value."
          },
          "other_city": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of another city where the contact is located."
          },
          "other_state": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of another state or province where the contact is located."
          },
          "other_zip": {
            "type": "string",
            "maxLength": 50,
            "description": "The zip or postal code associated with the contact's other address."
          },
          "other_country": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of another country where the contact is located."
          },
          "cf:custom_field_name": {
            "type": "string",
            "maxLength": 255,
            "description": "The name of this property is dynamic based on the custom fields you want to import. Use a key-value pair where the key is an existing custom field name prefixed with cf: , and the value is a custom field string value. For example, if you have a custom field named first_name you can use \"cf:first_name\":\"Joe\" . Each contact can contain up to 25 different custom fields."
          },
          "sms_number": {
            "type": "string",
            "maxLength": 16,
            "description": "The US phone number to associate with the contact's SMS-enabled phone. The country code must be valid. Valid formats are 1231231234 or 123-123-1234 . Required if `email` is not specified."
          },
          "sms_consent_date": {
            "type": "string",
            "maxLength": 16,
            "description": "Required if the SMS permission is set to `explicit`. The date that the contact consented to receiving SMS messages. Valid date formats are MM/DD/YYYY, M/D/YYYY, YYYY/MM/DD, YYYY/M/D, YYYY-MM-DD, YYYY-M-D,M-D-YYYY, or M-DD-YYYY."
          }
        },
        "additionalProperties": false
      },
      "ListActivityAddContacts": {
        "type": "object",
        "required": [
          "list_ids",
          "source"
        ],
        "properties": {
          "source": {
            "type": "object",
            "description": "The source object specifies which contacts you are adding to your targeted lists using one of four mutually exclusive properties.",
            "properties": {
              "list_ids": {
                "type": "array",
                "maxItems": 25,
                "description": "Specifies which contacts you are adding to lists as an array of up to 50 contact list_id values. This property is mutually exclusive with contact_ids , all_active_contacts (billable), and segment_id .",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "all_active_contacts": {
                "type": "boolean",
                "description": "Adds all active (billable) contacts to your targeted lists. This property is mutually exclusive with contact_ids , list_ids , and segment_id ."
              },
              "contact_ids": {
                "type": "array",
                "maxItems": 25,
                "description": "Specifies which contacts (up to 500) you are adding to lists as an array of contact_id values. This property is mutually exclusive with list_ids , all_active_contacts (billable), and segment_id .",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "tag_ids": {
                "type": "array",
                "maxItems": 0,
                "description": "Adds all contacts assigned with the specified tag_id s to your target lists. This property is mutually exclusive with all other source properties.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "engagement_level": {
                "type": "string",
                "enum": [
                  "unqualified",
                  "low",
                  "medium",
                  "high"
                ],
                "description": "Adds all contacts that meet the selected engagement_level to your target lists. This property is mutually exclusive with all other source properties.",
                "maxLength": 262144
              },
              "segment_id": {
                "type": "integer",
                "description": "Specifies which contacts you are adding to lists as a single segment_id value. This property is mutually exclusive with list_ids , all_active_contacts (billable), and contact_ids .",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false
          },
          "exclude": {
            "type": "object",
            "properties": {
              "contact_ids": {
                "type": "array",
                "description": "Excludes specified contacts ( contact_id ) from being added to the target list. Applicable if using either the all_active_contacts (billable) or list_ids as the source.",
                "items": {
                  "type": "string",
                  "description": "An array of contact_id s to exclude.",
                  "maxLength": 262144
                },
                "maxItems": 25
              }
            },
            "additionalProperties": false
          },
          "list_ids": {
            "type": "array",
            "maxItems": 25,
            "description": "Specifies which lists (up to 50) you are adding your source contacts to.",
            "items": {
              "type": "string",
              "maxLength": 262144
            }
          }
        },
        "additionalProperties": false
      },
      "TagAddRemoveContacts": {
        "type": "object",
        "required": [
          "source",
          "tag_ids"
        ],
        "properties": {
          "source": {
            "type": "object",
            "description": "Select the source used to identify contacts to which a tag is added or removed. Source types are mutually exclusive.",
            "properties": {
              "contact_ids": {
                "type": "array",
                "maxItems": 25,
                "description": "An array of contacts IDs.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "list_ids": {
                "type": "array",
                "maxItems": 25,
                "description": "An array of list IDs ( list_id ).",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "tag_ids": {
                "type": "array",
                "maxItems": 25,
                "description": "An array of tags ( tag_id ).",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "all_active_contacts": {
                "type": "boolean",
                "description": "Use to identify contacts with an active (billable) status."
              },
              "new_subscriber": {
                "type": "boolean",
                "description": "Use to identify newly subscribed contacts."
              }
            },
            "additionalProperties": false
          },
          "exclude": {
            "type": "object",
            "description": "Use to exclude specified contacts from being added or removed from a tag. Only applicable if the specified source is either all_active_contacts (billable) or list_ids .",
            "properties": {
              "contact_ids": {
                "type": "array",
                "description": "Identifies the contacts, by contact_id , to exclude from the add or remove tags activity.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 25
              }
            },
            "additionalProperties": false
          },
          "tag_ids": {
            "type": "array",
            "maxItems": 25,
            "description": "An array of tags ( tag_id ) to add to all contacts meeting the specified source criteria.",
            "items": {
              "type": "string",
              "description": "A list of tags to which contacts are added or removed.",
              "maxLength": 262144
            }
          }
        },
        "additionalProperties": false
      },
      "SegmentData": {
        "type": "object",
        "required": [
          "name",
          "segment_criteria"
        ],
        "properties": {
          "name": {
            "type": "string",
            "description": "The segment's unique descriptive name.",
            "maxLength": 262144
          },
          "segment_criteria": {
            "type": "string",
            "maxLength": 20000,
            "description": "The segment_criteria specifies the contact data that Constant Contact uses to evaluate and identify contacts that meet your criteria. The segment_criteria must be formatted as single-string escaped JSON. The top-level group type must be add ."
          }
        },
        "additionalProperties": false
      },
      "SegmentName": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "name": {
            "type": "string",
            "description": "The segment's unique descriptive name.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "ContactPutRequest": {
        "type": "object",
        "required": [
          "update_source"
        ],
        "properties": {
          "email_address": {
            "$ref": "#/$defs/EmailAddressPut"
          },
          "first_name": {
            "type": "string",
            "maxLength": 50,
            "description": "The contact's first name"
          },
          "last_name": {
            "type": "string",
            "maxLength": 50,
            "description": "The contact's last name"
          },
          "job_title": {
            "type": "string",
            "maxLength": 50,
            "description": "The contact's job title"
          },
          "company_name": {
            "type": "string",
            "maxLength": 50,
            "description": "Name of the company the contact works for."
          },
          "birthday_month": {
            "type": "integer",
            "description": "Accepts values from 1-12; must be used with birthday_day",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "birthday_day": {
            "type": "integer",
            "description": "Accepts values from 1-31; must be used with birthday_month",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "anniversary": {
            "type": "string",
            "maxLength": 10,
            "description": "The anniversary date; Accepted formats are MM/DD/YYYY, M/D/YYYY, YYYY/MM/DD, YYYY/M/D, YYYY-MM-DD, YYYY-M-D, MM-DD-YYYY, M-D-YYYY"
          },
          "update_source": {
            "type": "string",
            "enum": [
              "Account",
              "Contact"
            ],
            "description": "Identifies who last updated the contact; valid values are Contact or Account .",
            "maxLength": 262144
          },
          "custom_fields": {
            "type": "array",
            "maxItems": 25,
            "description": "Array of up to 25 custom_field subresources.",
            "items": {
              "$ref": "#/$defs/ContactCustomField"
            }
          },
          "phone_numbers": {
            "type": "array",
            "maxItems": 3,
            "description": "Array of up to 3 phone_numbers subresources.",
            "items": {
              "$ref": "#/$defs/PhoneNumberPut"
            }
          },
          "street_addresses": {
            "type": "array",
            "maxItems": 3,
            "description": "Array of up to 3 street_addresses subresources.",
            "items": {
              "$ref": "#/$defs/StreetAddressPut"
            }
          },
          "list_memberships": {
            "type": "array",
            "maxItems": 25,
            "description": "Array of up to 50 list_ids to which the contact is subscribed.",
            "items": {
              "type": "string",
              "description": "Unique list ID to which the contact is subscribed.",
              "maxLength": 262144
            }
          },
          "taggings": {
            "type": "array",
            "maxItems": 25,
            "description": "Array of tags ( tag_id ) assigned to the contact, up to a maximum of 50.",
            "items": {
              "type": "string",
              "description": "Unique ID of a tag assigned to the contact, up to a maximum of 50.",
              "maxLength": 262144
            }
          },
          "notes": {
            "type": "array",
            "maxItems": 25,
            "description": "An array of notes about the contact listed by most recent note first.",
            "items": {
              "$ref": "#/$defs/Note"
            }
          },
          "sms_channel": {
            "$ref": "#/$defs/ContactSmsChannel"
          }
        },
        "additionalProperties": false
      },
      "EmailAddressPut": {
        "type": "object",
        "required": [
          "address"
        ],
        "description": "The contact's email address and related properties.",
        "properties": {
          "address": {
            "type": "string",
            "maxLength": 80,
            "description": "The email address of the contact. The email address must be unique for each contact."
          },
          "permission_to_send": {
            "type": "string",
            "enum": [
              "implicit",
              "explicit",
              "pending_confirmation",
              "unsubscribed",
              "temp_hold",
              "not_set"
            ],
            "description": "Identifies the type of permission that the Constant Contact account has to send email to the contact. Types of permission: explicit, implicit, not_set, pending_confirmation, temp_hold, unsubscribed.",
            "maxLength": 262144
          },
          "opt_out_reason": {
            "type": "string",
            "maxLength": 255,
            "description": "The reason, as provided by the contact, that they unsubscribed/opted-out of receiving email campaigns."
          }
        },
        "additionalProperties": false
      },
      "ContactCustomField": {
        "type": "object",
        "required": [
          "custom_field_id"
        ],
        "description": "Custom fields allow Constant Contact users to add custom content to a contact that can be used to personalize emails in addition to the standard set of variables available for email personalization.",
        "properties": {
          "custom_field_id": {
            "type": "string",
            "description": "The custom field's unique ID",
            "maxLength": 262144
          },
          "value": {
            "type": "string",
            "maxLength": 255,
            "description": "The custom field value."
          },
          "choice_ids": {
            "type": "array",
            "description": "For >multi_select and single_select data types, the ID that uniquely identifies the choice associated with a the custom field.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "PhoneNumberPut": {
        "type": "object",
        "properties": {
          "phone_number": {
            "type": "string",
            "maxLength": 25,
            "description": "The contact's phone number."
          },
          "kind": {
            "type": "string",
            "enum": [
              "home",
              "work",
              "mobile",
              "other"
            ],
            "description": "Identifies the type of phone number; valid values are home, work, mobile, or other.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "StreetAddressPut": {
        "type": "object",
        "required": [
          "kind"
        ],
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "home",
              "work",
              "other"
            ],
            "description": "Describes the type of address; valid values are home, work, or other.",
            "maxLength": 262144
          },
          "street": {
            "type": "string",
            "maxLength": 255,
            "description": "Number and street of the address."
          },
          "city": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the city where the contact lives."
          },
          "state": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the state or province where the contact lives."
          },
          "postal_code": {
            "type": "string",
            "maxLength": 50,
            "description": "The zip or postal code of the contact."
          },
          "country": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the country where the contact lives."
          }
        },
        "additionalProperties": false
      },
      "Note": {
        "type": "object",
        "description": "A note about the contact.",
        "properties": {
          "note_id": {
            "type": "string",
            "description": "The ID that uniquely identifies the note (UUID format).",
            "maxLength": 262144
          },
          "created_at": {
            "type": "string",
            "description": "The date that the note was created.",
            "maxLength": 262144
          },
          "content": {
            "type": "string",
            "maxLength": 2000,
            "description": "The content for the note."
          }
        },
        "additionalProperties": false
      },
      "ContactSmsChannel": {
        "type": "object",
        "required": [
          "full_sms_address",
          "sms_channel_consents"
        ],
        "properties": {
          "full_sms_address": {
            "type": "string",
            "description": "The SMS-capable phone number for the Contact, including the dial code",
            "maxLength": 262144
          },
          "sms_channel_consents": {
            "type": "array",
            "description": "The consents for the SMS Channel.",
            "items": {
              "$ref": "#/$defs/ContactSmsChannelConsents"
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "ContactSmsChannelConsents": {
        "type": "object",
        "required": [
          "consent_type",
          "sms_consent_permission"
        ],
        "properties": {
          "sms_consent_permission": {
            "type": "string",
            "enum": [
              "explicit"
            ],
            "description": "The current status of the SMS channel.",
            "maxLength": 262144
          },
          "consent_type": {
            "type": "string",
            "enum": [
              "promotional_sms"
            ],
            "description": "The type of consent provided.",
            "maxLength": 262144
          },
          "consent_medium_details": {
            "type": "string",
            "description": "Additional information about the consent such as the type of device used.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "ContactPostRequest": {
        "type": "object",
        "properties": {
          "email_address": {
            "$ref": "#/$defs/EmailAddressPost"
          },
          "first_name": {
            "type": "string",
            "maxLength": 50,
            "description": "The first name of the contact."
          },
          "last_name": {
            "type": "string",
            "maxLength": 50,
            "description": "The last name of the contact."
          },
          "job_title": {
            "type": "string",
            "maxLength": 50,
            "description": "The job title of the contact."
          },
          "company_name": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the company where the contact works."
          },
          "create_source": {
            "type": "string",
            "enum": [
              "Account",
              "Contact"
            ],
            "description": "Describes who added the contact; valid values are Contact or Account . Your integration must accurately identify create_source for compliance reasons; value is set on POST, and is read-only going forward.",
            "maxLength": 262144
          },
          "birthday_month": {
            "type": "integer",
            "description": "The month value for the contact's birthday. Valid values are from 1 through 12. The birthday_month property is required if you use birthday_day .",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "birthday_day": {
            "type": "integer",
            "description": "The day value for the contact's birthday. Valid values are from 1 through 31. The birthday_day property is required if you use birthday_month .",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "anniversary": {
            "type": "string",
            "maxLength": 10,
            "description": "The anniversary date for the contact. For example, this value could be the date when the contact first became a customer of an organization in Constant Contact. Valid date formats are MM/DD/YYYY, M/D/YYYY, YYYY/MM/DD, YYYY/M/D, YYYY-MM-DD, YYYY-M-D,M-D-YYYY, or M-DD-YYYY."
          },
          "custom_fields": {
            "type": "array",
            "maxItems": 25,
            "description": "Array of up to 25 custom_field key value pairs.",
            "items": {
              "$ref": "#/$defs/ContactCustomField"
            }
          },
          "phone_numbers": {
            "type": "array",
            "maxItems": 3,
            "description": "Array of up to 3 phone numbers subresources.",
            "items": {
              "$ref": "#/$defs/PhoneNumberPut"
            }
          },
          "street_addresses": {
            "type": "array",
            "maxItems": 3,
            "description": "Array of up to 3 street address subresources.",
            "items": {
              "$ref": "#/$defs/StreetAddressPut"
            }
          },
          "list_memberships": {
            "type": "array",
            "maxItems": 25,
            "description": "Array of list_id s to which the contact is being subscribed, up to a maximum of 50.",
            "items": {
              "type": "string",
              "description": "Unique ID of a list to which the contact is subscribed, up to a maximum of 50.",
              "maxLength": 262144
            }
          },
          "taggings": {
            "type": "array",
            "maxItems": 25,
            "description": "Array of tags ( tag_id ) assigned to the contact, up to a maximum of 50.",
            "items": {
              "type": "string",
              "description": "Unique ID of a tag assigned to the contact, up to a maximum of 50.",
              "maxLength": 262144
            }
          },
          "notes": {
            "type": "array",
            "maxItems": 25,
            "description": "An array of notes about the contact.",
            "items": {
              "$ref": "#/$defs/Note"
            }
          },
          "sms_channel": {
            "$ref": "#/$defs/ContactSmsChannel"
          }
        },
        "additionalProperties": false
      },
      "EmailAddressPost": {
        "type": "object",
        "required": [
          "address"
        ],
        "description": "The contact's email address and related properties.",
        "properties": {
          "address": {
            "type": "string",
            "maxLength": 80,
            "description": "The contact's email address."
          },
          "permission_to_send": {
            "type": "string",
            "enum": [
              "implicit",
              "explicit",
              "pending_confirmation",
              "unsubscribed",
              "temp_hold",
              "not_set"
            ],
            "description": "Identifies the type of permission that the Constant Contact account has been granted to send email to the contact. Types of permission: explicit, implicit, not_set, pending_confirmation, temp_hold, unsubscribed.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "ContactCreateOrUpdateInput": {
        "type": "object",
        "required": [
          "list_memberships"
        ],
        "properties": {
          "email_address": {
            "type": "string",
            "maxLength": 50,
            "description": "The email address for the contact. This method identifies each unique contact using their email address. If the email address exists in the account, this method updates the contact. If the email address is new, this method creates a new contact."
          },
          "first_name": {
            "type": "string",
            "maxLength": 50,
            "description": "The first name of the contact."
          },
          "last_name": {
            "type": "string",
            "maxLength": 50,
            "description": "The last name of the contact."
          },
          "job_title": {
            "type": "string",
            "maxLength": 50,
            "description": "The job title of the contact."
          },
          "company_name": {
            "type": "string",
            "maxLength": 50,
            "description": "The name of the company where the contact works."
          },
          "phone_number": {
            "type": "string",
            "maxLength": 25,
            "description": "The phone number for the contact."
          },
          "list_memberships": {
            "type": "array",
            "minItems": 1,
            "maxItems": 25,
            "description": "The contact lists you want to add the contact to as an array of up to 50 contact list_id values. You must include at least one list_id .",
            "items": {
              "type": "string",
              "maxLength": 262144
            }
          },
          "custom_fields": {
            "type": "array",
            "maxItems": 25,
            "description": "The custom fields you want to add to the contact as an array of up to 50 custom field objects.",
            "items": {
              "$ref": "#/$defs/CreateOrUpdateContactCustomField"
            }
          },
          "anniversary": {
            "type": "string",
            "description": "The anniversary date for the contact. For example, this value could be the date when the contact first became a customer of an organization in Constant Contact. Valid date formats are MM/DD/YYYY, M/D/YYYY, YYYY/MM/DD, YYYY/M/D, YYYY-MM-DD, YYYY-M-D,M-D-YYYY, or M-DD-YYYY.",
            "maxLength": 262144
          },
          "birthday_month": {
            "type": "integer",
            "description": "The month value for the contact's birthday. Valid values are from 1 through 12. The birthday_month property is required if you use birthday_day .",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "birthday_day": {
            "type": "integer",
            "description": "The day value for the contact's birthday. Valid values are from 1 through 31. The birthday_day property is required if you use birthday_month .",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "street_address": {
            "type": "object",
            "required": [
              "kind"
            ],
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "home",
                  "work",
                  "other"
                ],
                "description": "The type of street address for the contact. Valid values are home , work , or other .",
                "maxLength": 262144
              },
              "street": {
                "type": "string",
                "maxLength": 255,
                "description": "The number and street of the contact's address."
              },
              "city": {
                "type": "string",
                "maxLength": 50,
                "description": "The name of the city for the contact's address."
              },
              "state": {
                "type": "string",
                "maxLength": 50,
                "description": "The name of the state or province for the contact's address."
              },
              "postal_code": {
                "type": "string",
                "maxLength": 50,
                "description": "The zip or postal code for the contact's address."
              },
              "country": {
                "type": "string",
                "maxLength": 50,
                "description": "The name of the country for the contact's address."
              }
            },
            "additionalProperties": false
          },
          "sms_channel": {
            "$ref": "#/$defs/JmmlSmsChannel"
          }
        },
        "additionalProperties": false
      },
      "CreateOrUpdateContactCustomField": {
        "type": "object",
        "properties": {
          "custom_field_id": {
            "type": "string",
            "description": "The unique ID for the custom_field .",
            "maxLength": 262144
          },
          "value": {
            "type": "string",
            "maxLength": 255,
            "description": "The value of the custom_field ."
          }
        },
        "additionalProperties": false
      },
      "JmmlSmsChannel": {
        "type": "object",
        "required": [
          "country_code",
          "dial_code",
          "sms_address",
          "sms_channel_consents"
        ],
        "description": "The contact's SMS details.",
        "properties": {
          "sms_address": {
            "type": "string",
            "description": "The contact's SMS-capable phone number, excluding the country code.",
            "maxLength": 262144
          },
          "dial_code": {
            "type": "string",
            "description": "The dial code the country uses. For example, use 1 for the United States dial code.",
            "maxLength": 262144
          },
          "country_code": {
            "type": "string",
            "description": "The two-digit code that identifies the country.",
            "maxLength": 262144
          },
          "sms_channel_consents": {
            "type": "array",
            "description": "The consents provided for the SMS Channel.",
            "items": {
              "$ref": "#/$defs/JmmlSmsChannelConsents"
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "JmmlSmsChannelConsents": {
        "type": "object",
        "required": [
          "consent_medium_details",
          "consent_medium_type",
          "consent_medium_url",
          "consent_type",
          "sms_consent_permission"
        ],
        "properties": {
          "sms_consent_permission": {
            "type": "string",
            "enum": [
              "pending_confirmation"
            ],
            "description": "The current consent status of the SMS Channel.",
            "maxLength": 262144
          },
          "consent_type": {
            "type": "string",
            "enum": [
              "promotional_sms"
            ],
            "description": "The type of consent provided.",
            "maxLength": 262144
          },
          "consent_medium_type": {
            "type": "string",
            "description": "A code representing where the consent was retrieved.",
            "maxLength": 262144
          },
          "consent_medium_url": {
            "type": "string",
            "description": "The URL for which the consent was gathered, such as a landing page.",
            "maxLength": 262144
          },
          "consent_medium_details": {
            "type": "string",
            "description": "Additional information for the consent",
            "maxLength": 262144
          },
          "advertised_frequency": {
            "type": "integer",
            "description": "The numeric component used to indicate how often to send advertising. For example, 1 indicates once. Use with advertised_internal property to indicate when on the calender to send it. For example, to send once ( 1 ) daily, weekly, or monthly.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "advertised_interval": {
            "type": "string",
            "enum": [
              "daily",
              "weekly",
              "monthly"
            ],
            "description": "The calender interval used to indicate when advertising is sent. For example weekly .",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "CustomFieldPutRequest": {
        "type": "object",
        "properties": {
          "label": {
            "type": "string",
            "maxLength": 50,
            "description": "The custom field name to display in the UI (free-form text)."
          },
          "choices": {
            "type": "array",
            "maxItems": 25,
            "description": "Array of choices for custom fields of type: single_select or multi_select . Maximum number of elements for checkbox and radio display types is 20. Maximum number of elements for a dropdown is 100.",
            "items": {
              "$ref": "#/$defs/CustomFieldChoicePutRequest"
            }
          }
        },
        "additionalProperties": false
      },
      "CustomFieldChoicePutRequest": {
        "type": "object",
        "description": "The single_select and multi_select custom field options.",
        "properties": {
          "choice_id": {
            "type": "integer",
            "description": "The ID that uniquely identifies the choice.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "choice_label": {
            "type": "string",
            "maxLength": 255,
            "description": "Label to display for the choice on the user interface."
          },
          "display_order": {
            "type": "integer",
            "description": "Stores the order for displaying a list of choices.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "CustomFieldRequest": {
        "type": "object",
        "properties": {
          "label": {
            "type": "string",
            "maxLength": 50,
            "description": "The custom field name to display in the UI (free-form text)."
          },
          "type": {
            "type": "string",
            "enum": [
              "date",
              "string",
              "datetime",
              "single_select",
              "currency",
              "text_area",
              "multi_select",
              "number",
              "boolean"
            ],
            "maxLength": 20,
            "description": "The type of data to store in the custom field."
          },
          "metadata": {
            "$ref": "#/$defs/CustomFieldMetadata"
          },
          "choices": {
            "type": "array",
            "maxItems": 25,
            "description": "Array of choices for custom fields of type: single_select or multi_select . Maximum number of elements for checkbox and radio display types is 20. Maximum number of elements for a dropdown is 100.",
            "items": {
              "$ref": "#/$defs/CustomFieldChoiceRequest"
            }
          },
          "version": {
            "type": "integer",
            "description": "Available if data type is date . Displays 1 if using legacy date fields where values are stored as strings. Displays 2 if using new date fields where values are stored as actual dates to support date comparisons and validations.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "CustomFieldMetadata": {
        "type": "object",
        "description": "Additional details about a custom field in JSON format.",
        "properties": {
          "display_type": {
            "type": "string",
            "enum": [
              "dropdown",
              "checkbox",
              "radio"
            ],
            "description": "Determines how Constant Contact renders a single_select or multi_select field.",
            "maxLength": 262144
          },
          "allow_negative": {
            "type": "boolean",
            "description": "For type number , determines if a value can be negative. By default, this value is false for the type number ."
          },
          "decimal_places": {
            "type": "integer",
            "description": "For types number and currency , determines the number of decimal places possible in the value.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "currency_code": {
            "type": "string",
            "enum": [
              "USD",
              "CAD",
              "AUD",
              "CHF",
              "CZK",
              "DKK",
              "EUR",
              "GBP",
              "HKD",
              "HUF",
              "ILS",
              "JPY",
              "MXN",
              "NOK",
              "NZD",
              "PHP",
              "PLN",
              "SEK",
              "SGD",
              "THB",
              "TWD"
            ],
            "description": "For type currency , specifies the three-letter currency code to assign.",
            "maxLength": 262144
          },
          "integer": {
            "type": "boolean",
            "description": "For types number and currency , determines whether the custom field should store only whole numbers (integers) without decimal values. If the integer is set to false , the decimal_places must be between 1 and 4."
          },
          "display_format": {
            "type": "string",
            "enum": [
              "YYYY-MM-DD",
              "DD/MM/YYYY",
              "MM/DD/YYYY"
            ],
            "description": "Specifies the display format for date fields in the user interface. If not specified for a date type field, defaults to YYYY-MM-DD format. Valid only for version 2 type dates (values are stored as actual dates to support date comparisons and validations).",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "CustomFieldChoiceRequest": {
        "type": "object",
        "description": "The single_select and multi_select custom field options.",
        "properties": {
          "choice_label": {
            "type": "string",
            "maxLength": 255,
            "description": "Label to display for the choice on the user interface."
          },
          "display_order": {
            "type": "integer",
            "description": "Stores the order for displaying a list of choices.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "ListInput": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "name": {
            "type": "string",
            "maxLength": 255,
            "description": "The name given to the contact list"
          },
          "favorite": {
            "type": "boolean",
            "description": "Identifies whether or not the account has favorited the contact list."
          },
          "description": {
            "type": "string",
            "description": "Text describing the list.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "TagPut": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255,
            "description": "The new tag name to use. The tag name must be unique."
          }
        },
        "additionalProperties": false
      },
      "TagPost": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255,
            "description": "Specify a unique name to use to identify the tag. Tag names must be at least one character in length and not more than 255 characters."
          },
          "tag_source": {
            "type": "string",
            "description": "The source used to identify the contacts to tag.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "EmailCampaignComplete": {
        "type": "object",
        "required": [
          "email_campaign_activities",
          "name"
        ],
        "properties": {
          "name": {
            "type": "string",
            "maxLength": 80,
            "description": "The unique and descriptive name that you specify for the email campaign."
          },
          "email_campaign_activities": {
            "type": "array",
            "description": "The content of the email campaign as an array that contains a single email campaign activity object.",
            "items": {
              "$ref": "#/$defs/EmailCampaignActivityInput"
            },
            "maxItems": 25
          }
        },
        "additionalProperties": false
      },
      "EmailCampaignActivityInput": {
        "type": "object",
        "required": [
          "format_type",
          "from_email",
          "from_name",
          "html_content",
          "reply_to_email",
          "subject"
        ],
        "properties": {
          "format_type": {
            "type": "integer",
            "enum": [
              5,
              4
            ],
            "description": "The email format you are using to create the email campaign activity. The V3 API supports creating emails using format_type 4 (email editor) and 5 (custom code emails).",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "from_name": {
            "type": "string",
            "maxLength": 100,
            "description": "The email sender's name to display for the email campaign activity."
          },
          "from_email": {
            "type": "string",
            "maxLength": 80,
            "description": "The sender's email address to use for the email campaign activity. You must use a confirmed Constant Contact account email address. Make a GET call to /account/emails to return a collection of account emails and their confirmation status."
          },
          "reply_to_email": {
            "type": "string",
            "maxLength": 80,
            "description": "The sender's email address to use if the contact replies to the email campaign activity. You must use a confirmed Constant Contact account email address. Make a GET call to /account/emails to return a collection of account emails and their confirmation status."
          },
          "subject": {
            "type": "string",
            "description": "The text to display in the subject line that describes the email campaign activity.",
            "maxLength": 262144
          },
          "preheader": {
            "type": "string",
            "maxLength": 200,
            "description": "The email preheader for the email campaign activity. Contacts will view your preheader as a short summary that follows the subject line in their email client. Only format_type 3, 4, and 5 email campaign activities use the preheader property."
          },
          "html_content": {
            "type": "string",
            "maxLength": 150000,
            "description": "The HTML content for the email campaign activity. Only format_type 5 (custom code emails) can contain html_content . When creating a format_type 5 custom code email, make sure that you include [[trackingImage]] in the &lt;body&gt; element of your HTML."
          },
          "physical_address_in_footer": {
            "$ref": "#/$defs/EmailPhysicalAddress"
          }
        },
        "additionalProperties": false
      },
      "EmailPhysicalAddress": {
        "type": "object",
        "required": [
          "address_line1",
          "country_code",
          "organization_name"
        ],
        "properties": {
          "address_line1": {
            "type": "string",
            "description": "Line 1 of the organization's street address.",
            "maxLength": 262144
          },
          "address_line2": {
            "type": "string",
            "description": "Line 2 of the organization's street address.",
            "maxLength": 262144
          },
          "address_line3": {
            "type": "string",
            "description": "Line 3 of the organization's street address.",
            "maxLength": 262144
          },
          "address_optional": {
            "type": "string",
            "description": "An optional address field for the organization. Only format_type 3, 4, and 5 can use this property.",
            "maxLength": 262144
          },
          "city": {
            "type": "string",
            "description": "The city where the organization sending the email campaign is located.",
            "maxLength": 262144
          },
          "country_code": {
            "type": "string",
            "description": "The uppercase two letter ISO 3166-1 code for the organization's country.",
            "maxLength": 262144
          },
          "organization_name": {
            "type": "string",
            "description": "The name of the organization that is sending the email campaign.",
            "maxLength": 262144
          },
          "postal_code": {
            "type": "string",
            "description": "The postal code address (ZIP code) of the organization.",
            "maxLength": 262144
          },
          "state_code": {
            "type": "string",
            "description": "The uppercase two letter ISO 3166-1 code for the organization's state. This property is required if the country_code is US (United States).",
            "maxLength": 262144
          },
          "state_non_us_name": {
            "type": "string",
            "description": "The full state name for a state_code that is outside the United States. This property is not read only.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "EmailCampaignName": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "name": {
            "type": "string",
            "maxLength": 80,
            "description": "The updated email campaign name. The email campaign name must be unique."
          }
        },
        "additionalProperties": false
      },
      "EmailCampaignActivity": {
        "type": "object",
        "required": [
          "from_email",
          "from_name",
          "reply_to_email",
          "subject"
        ],
        "properties": {
          "contact_list_ids": {
            "type": "array",
            "description": "The contacts that Constant Contact sends the email campaign activity to as an array of contact list_id values. You cannot use contact lists and segments at the same time in an email campaign activity.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 25
          },
          "segment_ids": {
            "type": "array",
            "description": "The contacts that Constant Contact sends the email campaign activity to as an array containing a single segment_id value. Only format_type 3, 4, and 5 email campaign activities support segments. You cannot use contact lists and segments at the same time in an email campaign activity.",
            "items": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "maxItems": 25
          },
          "from_email": {
            "type": "string",
            "description": "The email \"From Email\" field for the email campaign activity. You must use a confirmed Constant Contact account email address. Make a GET call to /account/emails to return a collection of account emails and their confirmation status.",
            "maxLength": 262144
          },
          "from_name": {
            "type": "string",
            "description": "The email \"From Name\" field for the email campaign activity.",
            "maxLength": 262144
          },
          "reply_to_email": {
            "type": "string",
            "description": "The email \"Reply To Email\" field for the email campaign activity. You must use a confirmed Constant Contact account email address. Make a GET call to /account/emails to return a collection of account emails and their confirmation status.",
            "maxLength": 262144
          },
          "subject": {
            "type": "string",
            "description": "The email \"Subject\" field for the email campaign activity.",
            "maxLength": 262144
          },
          "html_content": {
            "type": "string",
            "description": "The HTML or XHTML content for the email campaign activity. Only format_type 1 and 5 (legacy custom code emails or modern custom code emails) can contain html_content .",
            "maxLength": 262144
          },
          "preheader": {
            "type": "string",
            "description": "The email preheader for the email campaign activity. Only format_type 3, 4, and 5 email campaign activities use the preheader property.",
            "maxLength": 262144
          },
          "physical_address_in_footer": {
            "$ref": "#/$defs/EmailPhysicalAddress"
          },
          "document_id": {
            "type": "string",
            "description": "Identifies the email document used in an email editor (format_type 4) email campaign.",
            "maxLength": 262144
          },
          "document_properties": {
            "type": "object",
            "description": "An object that contains optional properties for legacy format type emails ( format_type 1 and 2). If you attempt to add a property that does apply to the email format_type , the API will ignore the property.",
            "properties": {
              "style_content": {
                "type": "string",
                "maxLength": 150000,
                "description": "Contains style sheet elements for XHTML letter format emails. This property applies only to format_type 1."
              },
              "greeting_salutation": {
                "type": "string",
                "maxLength": 50,
                "description": "The greeting used in the email message. This property applies only to format_type 1."
              },
              "greeting_name_type": {
                "type": "string",
                "enum": [
                  "F",
                  "L",
                  "B",
                  "N"
                ],
                "description": "The type of name the campaign uses to greet the contact. Valid values are F (First Name), L (Last Name), B (First and Last Name), or N (No greeting). By default, the value is N . This property applies only to format_type 1.",
                "maxLength": 262144
              },
              "greeting_secondary": {
                "type": "string",
                "maxLength": 1500,
                "description": "A fallback text string the campaign uses to greet the contact when the greeting_name_type is not available or set to N . This property applies only to format_type 1."
              },
              "subscribe_link_enabled": {
                "type": "string",
                "enum": [
                  "true",
                  "false"
                ],
                "description": "If true , the email footer includes a link for subscribing to the list. If false , the message footer does not include a link for subscribing to the list. By default, the value is false . This property applies only to format_type 1.",
                "maxLength": 262144
              },
              "subscribe_link_name": {
                "type": "string",
                "maxLength": 80,
                "description": "The text displayed as the name for the subscribe link in the email footer. This property applies only to format_type 1."
              },
              "text_content": {
                "type": "string",
                "maxLength": 150000,
                "description": "Contains the text content that Constant Contact displays to contacts when their email client cannot display HTML email. If you do not specify text content, Constant Contact displays \"Greetings!\" as the text content. This property applies only to format_type 1."
              },
              "permission_reminder_enabled": {
                "type": "string",
                "enum": [
                  "false",
                  "true"
                ],
                "description": "If true , Constant Contact displays your permission_reminder message to contacts at top of the email. If false , Constant Contact does not display the message. By default, the value is false . This property applies to format_type 1 and 2.",
                "maxLength": 262144
              },
              "permission_reminder": {
                "type": "string",
                "maxLength": 1500,
                "description": "The message text Constant Contact displays at the top of the email message to remind users that they are subscribed to an email list. This property applies to format_type 1 and 2."
              },
              "view_as_webpage_enabled": {
                "type": "string",
                "description": "If true , Constant Contact displays the view as web page email message. If false Constant Contact does not display the message. By default, the value is false . This property applies to format_type 1 and 2.",
                "maxLength": 262144
              },
              "view_as_webpage_text": {
                "type": "string",
                "maxLength": 50,
                "description": "The text Constant Contact displays before the view as web page link at the top of the email. This property applies to format_type 1 and 2."
              },
              "view_as_webpage_link_name": {
                "type": "string",
                "description": "The name of the link that users can click to view the email as a web page. This property applies to format_type 1 and 2.",
                "maxLength": 262144
              },
              "forward_email_link_enabled": {
                "type": "string",
                "enum": [
                  "true",
                  "false"
                ],
                "description": "If true , when the user forwards an email message the footer includes a link for subscribing to the list. If false , when a user forwards an email message the footer does not include a link for subscribing to the list. By default, the value is false . This property applies to format_type 1 and 2.",
                "maxLength": 262144
              },
              "forward_email_link_name": {
                "type": "string",
                "maxLength": 80,
                "description": "The text displayed as the name for the forward email link in the footer when a user forwards an email. This property applies to format_type 1 and 2."
              }
            },
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      }
    },
    "H": {
      "EventDto": {
        "type": "object",
        "required": [
          "campaign_id",
          "default_track",
          "description",
          "event_end",
          "event_start",
          "event_type",
          "location_type",
          "name",
          "time_zone",
          "title"
        ],
        "properties": {
          "description": {
            "type": "string",
            "minLength": 0,
            "maxLength": 600,
            "description": "Provides the event description."
          },
          "title": {
            "type": "string",
            "maxLength": 100,
            "description": "The title for the event. The title does not have to be unique for an account."
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100,
            "description": "The name of the event, has to be unique for the account."
          },
          "event_id": {
            "type": "string",
            "description": "The ID that uniquely identifies the event.",
            "maxLength": 262144
          },
          "campaign_id": {
            "type": "string",
            "description": "The system assigned ID that uniquely identifies the event and is identical to the `event_id`.",
            "maxLength": 262144
          },
          "event_start": {
            "type": "string",
            "description": "The date the event starts.",
            "maxLength": 262144
          },
          "event_end": {
            "type": "string",
            "description": "The date the event ends.",
            "maxLength": 262144
          },
          "event_type": {
            "type": "string",
            "enum": [
              "AUCTION",
              "BIRTHDAY",
              "BUSINESS_FINANCE_SALES",
              "CLASSES_WORKSHOPS",
              "COMPETITION_SPORTS",
              "CONFERENCES_SEMINARS_FORUM",
              "CONVENTIONS_TRADESHOWS_EXPOS",
              "FESTIVALS_FAIRS",
              "FOOD_WINE",
              "FUNDRAISERS_CHARITIES",
              "HOLIDAY",
              "INCENTIVE_REWARD_RECOGNITION",
              "MOVIES_FILM",
              "MUSIC_CONCERTS",
              "NETWORKING_CLUBS",
              "OTHER",
              "OUTDOORS_RECREATION",
              "PARTIES_SOCIAL_EVENTS_MIXERS",
              "PERFORMING_ARTS",
              "RELIGION_SPIRITUALITY",
              "SCHOOLS_REUNIONS_ALUMNI",
              "TRAVEL",
              "WEBINAR_TELESEMINAR_TELECLASS",
              "WEDDINGS"
            ],
            "description": "Identifies the event type.",
            "maxLength": 262144
          },
          "contact": {
            "$ref": "#/$defs/ContactDto"
          },
          "create_time": {
            "type": "string",
            "description": "The time the event was created, in ISO format. Read-only.",
            "maxLength": 262144
          },
          "last_update_time": {
            "type": "string",
            "description": "The date and time the event was last modified.",
            "maxLength": 262144
          },
          "address": {
            "$ref": "#/$defs/AddressDto"
          },
          "currency_type": {
            "type": "string",
            "enum": [
              "USD",
              "CAD",
              "AUD",
              "BRL",
              "CHF",
              "CZK",
              "DKK",
              "EUR",
              "GBP",
              "HKD",
              "HUF",
              "ILS",
              "JPY",
              "MXN",
              "MYR",
              "NOK",
              "NZD",
              "PHP",
              "PLN",
              "RUB",
              "SEK",
              "SGD",
              "THB",
              "TRY",
              "TWD"
            ],
            "description": "The accepted currency for payments. Required for events collecting payments ['AUD','BRL','CAD','CHF','CZK','DKK','EUR','GBP','HKD','HUF','ILS','JPY','MXN','MYR','NOK','NZD','PHP','PLN','RUB','SEK','SGD','THB','TRY','TWD','USD']",
            "maxLength": 262144
          },
          "default_track": {
            "$ref": "#/$defs/TrackDto"
          },
          "display_contact_flag": {
            "type": "boolean",
            "description": "Display or hide event contact information on the registration form and registration confirmation message."
          },
          "display_end_time_flag": {
            "type": "boolean",
            "description": "Display or hide the event end time on the registration form and registration confirmation message."
          },
          "display_on_calendar_flag": {
            "type": "boolean",
            "description": "Display the event on the Event Calendar."
          },
          "display_time_zone_flag": {
            "type": "boolean",
            "description": "Display the time zone on the registration form and registration confirmation message."
          },
          "event_metadata": {
            "$ref": "#/$defs/EventMetaDataDto"
          },
          "event_code": {
            "type": "string",
            "description": "The short code to use for the event.",
            "maxLength": 262144
          },
          "event_settings": {
            "$ref": "#/$defs/EventSettingsDto"
          },
          "location_type": {
            "type": "string",
            "enum": [
              "BOTH",
              "PHYSICAL",
              "TBA",
              "VIRTUAL"
            ],
            "description": "Specifies if the event is physical and/or virtual, or to be determined.",
            "maxLength": 262144
          },
          "notify_owner_on_reg": {
            "type": "boolean",
            "description": "If `true`, sends an email to the event owner when a registration is made."
          },
          "online_meeting": {
            "$ref": "#/$defs/OnlineMeetingDto"
          },
          "status": {
            "type": "string",
            "enum": [
              "DRAFT",
              "ACTIVE",
              "CANCELED",
              "COMPLETE"
            ],
            "description": "Specifies the event's current status.",
            "maxLength": 262144
          },
          "time_zone": {
            "type": "string",
            "description": "The time zone where the event takes place.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "ContactDto": {
        "type": "object",
        "required": [
          "name",
          "organization_name"
        ],
        "properties": {
          "create_time": {
            "type": "string",
            "description": "The create time of the event.",
            "maxLength": 262144
          },
          "email_address": {
            "type": "string",
            "minLength": 0,
            "maxLength": 128,
            "description": "The email address to use to when replying to email, as well as the email that receives SO notifications."
          },
          "from_email_address": {
            "type": "string",
            "minLength": 0,
            "maxLength": 128,
            "description": "The email address to use for sending confirmation emails."
          },
          "last_update_time": {
            "type": "string",
            "description": "The time the event was last modified. ISO format",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "minLength": 0,
            "maxLength": 100,
            "description": "The contact name to associate with the event."
          },
          "organization_name": {
            "type": "string",
            "minLength": 0,
            "maxLength": 255,
            "description": "The organization name to associate with the event."
          },
          "phone_number": {
            "type": "string",
            "minLength": 1,
            "maxLength": 25,
            "description": "The phone number to associate with the event."
          }
        },
        "additionalProperties": false
      },
      "AddressDto": {
        "type": "object",
        "required": [
          "address_type"
        ],
        "properties": {
          "address_type": {
            "type": "string",
            "enum": [
              "EVENT",
              "PAYMENT"
            ],
            "description": "The address type. Only `EVENT` is currently supported.",
            "maxLength": 262144
          },
          "line1": {
            "type": "string",
            "minLength": 0,
            "maxLength": 80,
            "description": "The first line of the address where the event takes place."
          },
          "line2": {
            "type": "string",
            "minLength": 0,
            "maxLength": 80,
            "description": "The second line of the address where the event takes place."
          },
          "city": {
            "type": "string",
            "minLength": 0,
            "maxLength": 80,
            "description": "The city where the event takes place."
          },
          "country": {
            "type": "string",
            "minLength": 0,
            "maxLength": 128,
            "description": "Name of the country where the event takes place."
          },
          "country_code": {
            "type": "string",
            "minLength": 0,
            "maxLength": 2,
            "description": "The country code associated with the country where the event takes place."
          },
          "create_time": {
            "type": "string",
            "description": "The create time of the event.",
            "maxLength": 262144
          },
          "last_update_time": {
            "type": "string",
            "description": "The last modification time of the event.",
            "maxLength": 262144
          },
          "latitude": {
            "type": "number",
            "description": "The latitude number indicating where the event takes place."
          },
          "longitude": {
            "type": "number",
            "description": "The longitude number indicating where the event takes place."
          },
          "location_name": {
            "type": "string",
            "minLength": 0,
            "maxLength": 100,
            "description": "The venue name where the event takes place."
          },
          "postal_code": {
            "type": "string",
            "minLength": 0,
            "maxLength": 25,
            "description": "The address postal code."
          },
          "state": {
            "type": "string",
            "minLength": 0,
            "maxLength": 80,
            "description": "The State/Province where the event takes place."
          },
          "state_code": {
            "type": "string",
            "minLength": 0,
            "maxLength": 2,
            "description": "The state code where the event takes place."
          }
        },
        "additionalProperties": false
      },
      "TrackDto": {
        "type": "object",
        "required": [],
        "properties": {
          "items_header": {
            "type": "string",
            "description": "items header",
            "maxLength": 262144
          },
          "media_assets": {
            "type": "array",
            "description": "The list of media assets configured for the event.",
            "items": {
              "$ref": "#/$defs/EventMediaAssetDto"
            },
            "maxItems": 10
          },
          "overall_ticket_capacity": {
            "type": "integer",
            "description": "The total overall ticket capacity.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "platform_fee_scope_type": {
            "type": "string",
            "enum": [
              "REGISTRANT",
              "OWNER"
            ],
            "description": "Specifies if the platform fee is passed to registrant or absorbed by the event host.",
            "maxLength": 262144
          },
          "promo_codes": {
            "type": "array",
            "description": "The list of promo_codes configured for the event.",
            "items": {
              "$ref": "#/$defs/PromoCodeDto"
            },
            "maxItems": 10
          },
          "reg_manually_closed_flag": {
            "type": "boolean",
            "description": "Closes registration to prevent further registrations."
          },
          "registration_end_time": {
            "type": "string",
            "description": "The date and time when registration should end. ISO format.",
            "maxLength": 262144
          },
          "registration_type": {
            "type": "string",
            "enum": [
              "TICKET",
              "RSVP"
            ],
            "description": "The registration type for the event.",
            "maxLength": 262144
          },
          "restrict_to_single_ticket_flag": {
            "type": "boolean",
            "description": "Restricts selection to a single ticket."
          },
          "tickets_header": {
            "type": "string",
            "description": "The header to use for tickets.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "EventMediaAssetDto": {
        "type": "object",
        "properties": {
          "create_time": {
            "type": "string",
            "description": "Create time of the event media. ISO format.",
            "maxLength": 262144
          },
          "external_id": {
            "type": "string",
            "description": "The external ID to associate with the event media.",
            "maxLength": 262144
          },
          "external_url": {
            "type": "string",
            "description": "The event media URL.",
            "maxLength": 262144
          },
          "internal_id": {
            "type": "string",
            "description": "The internal ID for the event media.",
            "maxLength": 262144
          },
          "last_update_time": {
            "type": "string",
            "description": "Last time the media was modified. ISO format.",
            "maxLength": 262144
          },
          "media_type": {
            "type": "string",
            "enum": [
              "BNR",
              "ITM"
            ],
            "description": "Identifies the media type.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "PromoCodeDto": {
        "type": "object",
        "required": [
          "name"
        ],
        "description": "Specifies promotion code details.",
        "properties": {
          "name": {
            "type": "string",
            "description": "The name of the promotional code.",
            "maxLength": 262144
          },
          "end_time": {
            "type": "string",
            "description": "The date to end the promotional code. ISO format",
            "maxLength": 262144
          },
          "deleted_time": {
            "type": "string",
            "description": "Delete time of the promo code. ISO format.",
            "maxLength": 262144
          },
          "description": {
            "type": "string",
            "description": "Promotional code description.",
            "maxLength": 262144
          },
          "discount_amount": {
            "type": "number",
            "description": "The discount dollar amount date to apply to the promotional code."
          },
          "discount_code_scope": {
            "type": "string",
            "enum": [
              "TICKET_LIST",
              "ORDER_TOTAL",
              "com.constantcontact.eventsdtos.constants.evm.DiscountCodeScope@3b858ed8[id=T]",
              "com.constantcontact.eventsdtos.constants.evm.DiscountCodeScope@34dae070[id=O]"
            ],
            "description": "The scope that applies to the discount code.",
            "maxLength": 262144
          },
          "discount_code_type": {
            "type": "string",
            "enum": [
              "AMOUNT",
              "PERCENT",
              "com.constantcontact.eventsdtos.constants.evm.DiscountCodeType@3145b833[id=A]",
              "com.constantcontact.eventsdtos.constants.evm.DiscountCodeType@4e218fec[id=P]"
            ],
            "description": "The type of discount code to use for the event.",
            "maxLength": 262144
          },
          "discount_percent": {
            "type": "integer",
            "description": "The promotional discount percentage to apply for the promotional code.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "id": {
            "type": "string",
            "description": "The ID to use for the promotion code.",
            "maxLength": 262144
          },
          "items": {
            "type": "array",
            "description": "List of items associated with this promo code.",
            "items": {
              "$ref": "#/$defs/ItemSummaryDto"
            },
            "maxItems": 10
          },
          "paused_flag": {
            "type": "boolean",
            "description": "Pauses the promotional code."
          },
          "quantity_available": {
            "type": "integer",
            "description": "Total number of promotional codes available for use.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "quantity_total": {
            "type": "integer",
            "description": "Total number of promotional codes to accept.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "quantity_used": {
            "type": "integer",
            "description": "Total number of promotional codes used.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "start_time": {
            "type": "string",
            "description": "The date the promotional code starts. ISO format",
            "maxLength": 262144
          },
          "status": {
            "type": "string",
            "enum": [
              "com.constantcontact.eventsdtos.constants.evm.PromoCodeStatus@1980962c[id=1]",
              "com.constantcontact.eventsdtos.constants.evm.PromoCodeStatus@43853f89[id=2]",
              "com.constantcontact.eventsdtos.constants.evm.PromoCodeStatus@5a405b0f[id=3]",
              "com.constantcontact.eventsdtos.constants.evm.PromoCodeStatus@71529154[id=4]",
              "com.constantcontact.eventsdtos.constants.evm.PromoCodeStatus@6cfe48a4[id=5]",
              "1",
              "2",
              "3"
            ],
            "description": "The status of the promo code.",
            "maxLength": 262144
          },
          "tickets": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TicketSummaryDto"
            },
            "maxItems": 10
          },
          "time_limit_flag": {
            "type": "boolean",
            "description": "Indicates a time limit applies to the promotional code."
          }
        },
        "additionalProperties": false
      },
      "ItemSummaryDto": {
        "type": "object",
        "required": [
          "name"
        ],
        "description": "Summary information for an item.",
        "properties": {
          "associated": {
            "type": "boolean",
            "description": "Specifies if the item is associated with the promo code."
          },
          "display_item_on_promo_redemption": {
            "type": "boolean",
            "description": "Specifies if the item on promo code redemption displays."
          },
          "hidden_flag": {
            "type": "boolean",
            "description": "Specifies if the item is hidden."
          },
          "item_id": {
            "type": "string",
            "description": "The unique identifier for the item.",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "The name of the item.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "TicketSummaryDto": {
        "type": "object",
        "required": [
          "name",
          "ticket_type"
        ],
        "properties": {
          "name": {
            "type": "string",
            "description": "The name to associate with the ticket.",
            "maxLength": 262144
          },
          "ticket_id": {
            "type": "string",
            "description": "The unique identifier for the ticket.",
            "maxLength": 262144
          },
          "ticket_type": {
            "type": "string",
            "enum": [
              "FREE",
              "PAID"
            ],
            "description": "The type of ticket.",
            "maxLength": 262144
          },
          "associated": {
            "type": "boolean",
            "description": "Specifies if the ticket is associated with the promo code."
          },
          "display_ticket_on_promo_redemption": {
            "type": "boolean",
            "description": "Specifies if the ticket on the promo code redemption displays."
          },
          "hidden_flag": {
            "type": "boolean",
            "description": "Specifies if the ticket is hidden."
          }
        },
        "additionalProperties": false
      },
      "EventMetaDataDto": {
        "type": "object",
        "description": "Additional information related to event",
        "properties": {
          "items_enabled": {
            "type": "boolean",
            "description": "Specifies if the items are enabled for the event."
          },
          "paid_event": {
            "type": "boolean",
            "description": "Specifies if the event requires payment."
          },
          "promo_codes_enabled": {
            "type": "boolean",
            "description": "Specifies if promotion codes are enabled for the event."
          }
        },
        "additionalProperties": false
      },
      "EventSettingsDto": {
        "type": "object",
        "properties": {
          "event_requires_payments": {
            "type": "boolean",
            "description": "Specifies if the event is configured to require payment."
          },
          "item_configured": {
            "type": "boolean",
            "description": "Specifies if items exist for the event."
          },
          "online_payment_configured": {
            "type": "boolean",
            "description": "Specifies if online payment is configured for the event."
          },
          "payment_configured": {
            "type": "boolean",
            "description": "Specifies if payment is configured for the event."
          },
          "promo_code_configured": {
            "type": "boolean",
            "description": "Specifies if promo code is configured for the event."
          },
          "ticket_configured": {
            "type": "boolean",
            "description": "Specifies if ticketing is configured for the event"
          }
        },
        "additionalProperties": false
      },
      "OnlineMeetingDto": {
        "type": "object",
        "properties": {
          "create_time": {
            "type": "string",
            "description": "Create time of the event. ISO format.",
            "maxLength": 262144
          },
          "enabled_flag": {
            "type": "boolean"
          },
          "instructions": {
            "type": "string",
            "maxLength": 262144
          },
          "label": {
            "type": "string",
            "maxLength": 262144
          },
          "last_update_time": {
            "type": "string",
            "description": "Last modification time of the event. ISO format.",
            "maxLength": 262144
          },
          "provider_type": {
            "type": "string",
            "enum": [
              "ZOOM",
              "GOTOMEETING",
              "TEAMS",
              "WEBEX",
              "OTHER"
            ],
            "description": "The type of online meeting provider for the event",
            "maxLength": 262144
          },
          "url": {
            "type": "string",
            "description": "The URL to use for the online meeting.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "EventCopyRequestDto": {
        "type": "object",
        "required": [
          "target_event_name"
        ],
        "description": "Request payload for copying an event.",
        "properties": {
          "target_event_name": {
            "type": "string",
            "description": "Name for the copied event. Must be unique for the account.",
            "maxLength": 262144
          },
          "source_campaign_activities": {
            "type": "array",
            "description": "Optional array of campaign activity UUIDs to copy. If not provided, all activities are copied.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "OrderTicketKeysRequestDto": {
        "type": "object",
        "required": [
          "order_ticket_keys"
        ],
        "description": "Request payload for ticket check-in operations.",
        "properties": {
          "order_ticket_keys": {
            "type": "array",
            "description": "Array of order ticket keys to process.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "RegistrationStatusUpdateRequestDto": {
        "type": "object",
        "required": [
          "registration_ids",
          "registration_status"
        ],
        "description": "Request payload to update registration status.",
        "properties": {
          "registration_ids": {
            "type": "array",
            "description": "List of registration IDs to update.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "registration_status": {
            "type": "string",
            "enum": [
              "REGISTERED",
              "EXPIRED",
              "IN_PROGRESS",
              "CANCELED",
              "FAILED",
              "PENDING"
            ],
            "description": "New registration status to set.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "PaymentStatusUpdateRequestDto": {
        "type": "object",
        "required": [
          "payment_status",
          "registration_ids"
        ],
        "description": "Request payload to update payment status.",
        "properties": {
          "registration_ids": {
            "type": "array",
            "description": "List of registration IDs to update.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "payment_status": {
            "type": "string",
            "enum": [
              "Pending",
              "Paid",
              "Refunded"
            ],
            "description": "New payment status to set.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "PostCreateDto": {
        "type": "object",
        "required": [
          "profile_posts",
          "status"
        ],
        "description": "Request body for creating a social media post campaign that can include multiple posts to multiple social profiles.",
        "properties": {
          "name": {
            "type": "string",
            "description": "Campaign name for this post. Optional on creation. If not provided, a default name will be generated. The value provided will be sanitized before saving, so the value returned may not exactly match what was sent.",
            "maxLength": 262144
          },
          "profile_posts": {
            "type": "array",
            "description": "The list of per-profile posts that make up this campaign. Each entry specifies the content to post and the profiles to post it to.",
            "items": {
              "$ref": "#/$defs/ProfilePostDto"
            },
            "maxItems": 10
          },
          "scheduled_time": {
            "type": "string",
            "description": "The date and time to publish the post, in ISO-8601 format. Only applies when status is SCHEDULED . If not specified for a scheduled post, the publish job is scheduled to execute immediately.",
            "maxLength": 262144
          },
          "status": {
            "type": "string",
            "enum": [
              "DRAFT",
              "SCHEDULED"
            ],
            "description": "The status of the post on creation. Valid values are DRAFT (save without publishing) or SCHEDULED (schedule for publication).",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "ProfilePostDto": {
        "type": "object",
        "required": [
          "profiles"
        ],
        "description": "The content to post to one or more social profiles as part of a social post campaign.",
        "properties": {
          "images": {
            "type": "array",
            "description": "Images to include in the post. Each image must be accessible via a public URL.",
            "items": {
              "$ref": "#/$defs/ImageDto"
            },
            "maxItems": 10
          },
          "profiles": {
            "type": "array",
            "description": "The list of profiles to post to. Can be an empty list only when the post is in DRAFT status.",
            "items": {
              "$ref": "#/$defs/ProfilePostProfileDto"
            },
            "maxItems": 10
          },
          "settings": {
            "type": "object",
            "description": "Network-specific post settings. If no settings are provided, this field will be omitted in the JSON response. All values are persisted as strings. Currently, only TikTok has available settings: { \"settings\": { \"tiktok\": { \"disable_comment\": \"true\", \"disable_duet\": \"false\", \"disable_stitch\": \"true\", \"auto_add_music\": \"false\" } } }",
            "additionalProperties": {
              "$ref": "#/$defs/MapOfstringAndstring"
            }
          },
          "text": {
            "type": "string",
            "description": "The text/caption content for the post. Whether text is required depends on the target social network. In DRAFT status, this is always optional.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "ImageDto": {
        "type": "object",
        "required": [
          "url"
        ],
        "description": "An image to include in a social post.",
        "properties": {
          "url": {
            "type": "string",
            "description": "The URL of the image. Each component of the URL must be appropriately encoded to avoid illegal characters.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "ProfilePostProfileDto": {
        "type": "object",
        "required": [
          "profile_id"
        ],
        "description": "Describes a post to a single social profile, including the target profile and its current status on that network.",
        "properties": {
          "profile_id": {
            "type": "string",
            "description": "The unique identifier for the profile to post to. Use the profile_id from GET /social/profiles .",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "MapOfstringAndstring": {
        "type": "object",
        "additionalProperties": {
          "type": "string",
          "maxLength": 262144
        }
      },
      "ContactResubscribeRequest": {
        "type": "object",
        "required": [
          "list_ids"
        ],
        "properties": {
          "list_ids": {
            "type": "array",
            "description": "Array of list id values. Constant Contact adds the resubscribed contact to the contact lists you provide in the array.",
            "items": {
              "type": "string",
              "description": "Contact list id value.",
              "maxLength": 262144
            },
            "maxItems": 10
          }
        },
        "additionalProperties": false
      },
      "EmailScheduleInput": {
        "type": "object",
        "required": [
          "scheduled_date"
        ],
        "properties": {
          "scheduled_date": {
            "type": "string",
            "description": "The date when Constant Contact will send the email campaign activity to contacts in ISO-8601 format. For example, 2022-05-17 and 2022-05-17T16:37:59.091Z are valid dates. Use \"0\" as the date to have Constant Contact immediately send the email campaign activity to contacts.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "EmailTestSendInput": {
        "type": "object",
        "required": [
          "email_addresses"
        ],
        "properties": {
          "email_addresses": {
            "type": "array",
            "maxItems": 5,
            "description": "The recipients of the test email as an array of email address strings. You can send a test email to up to 5 different email addresses at a time.",
            "items": {
              "type": "string",
              "maxLength": 262144
            }
          },
          "personal_message": {
            "type": "string",
            "description": "A personal message for the recipients of the test email. Constant Contact displays this message before the email campaign activity content.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "ResendToNonOpenersInput": {
        "required": [
          "resend_subject"
        ],
        "type": "object",
        "properties": {
          "resend_subject": {
            "type": "string",
            "description": "The subject line used when resending the email campaign activity.",
            "maxLength": 262144
          },
          "delay_days": {
            "type": "integer",
            "description": "The number of days to wait before Constant Contact resends the email. Valid values include 1 to 10 days. This property is mutually exclusive with delay_minutes . This value is only returned in the response results if the resend activity was created with delay_days or the delay_minutes equal to an exact day value.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "delay_minutes": {
            "type": "integer",
            "description": "The number of minutes to wait before Constant Contact resends the email campaign activity. There are 1,440 minutes in a day. Valid values includes a minimum of 720 (12 hours) and a maximum of 14,400 minutes (10 days). This property is mutually exclusive with delay_days",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      },
      "TriggerDefDto": {
        "type": "object",
        "description": "Defines when the workflow starts (e.g., list join, date-based).",
        "properties": {
          "parameters": {
            "type": "array",
            "description": "List of parameters that filter or configure the trigger (e.g., list IDs for list_join).",
            "items": {
              "$ref": "#/$defs/ParameterDto"
            },
            "maxItems": 10
          },
          "action_name": {
            "type": "string",
            "description": "Action name. Required for type Action or Date. Identifies the specific trigger (e.g., list_join, calendar_date, visits_page).",
            "maxLength": 262144
          },
          "bounds": {
            "type": "object",
            "description": "Time window for Date-type triggers. Sets when the trigger runs relative to the contact's date. Uses ISO 8601 period format (e.g., P0D, P7D, P-7D). | Example Scenario | after | before | |----------|--------|--------| | On the day | `P0D` | `P1D` | | 7 days before | `P-7D` | `P-6D` | | 7 days after | `P7D` | `P8D` |",
            "properties": {
              "after": {
                "type": "string",
                "description": "Start of the window relative to the contact date in ISO 8601 period format (e.g., P0D = on the day, P-7D = 7 days before).",
                "maxLength": 262144
              },
              "before": {
                "type": "string",
                "description": "End of the window relative to the contact date in ISO 8601 period format (e.g., P1D = 1 day after, P0D = on the day).",
                "maxLength": 262144
              }
            },
            "additionalProperties": false
          },
          "engagement_level": {
            "type": "string",
            "description": "Engagement level for engagement_level triggers (e.g., SOMEWHAT, LEAST).",
            "maxLength": 262144
          },
          "segment_id": {
            "type": "string",
            "description": "Segment ID for segment_join triggers.",
            "maxLength": 262144
          },
          "trigger_date": {
            "type": "object",
            "description": "Date configuration for Date-type triggers (e.g., birthday, anniversary). Specifies which contact fields supply the date.",
            "properties": {
              "date_field": {
                "type": "string",
                "description": "Contact field that contains the full date. Must include 'record.' prefix (e.g., record.anniversary).",
                "maxLength": 262144
              },
              "day_field": {
                "type": "string",
                "description": "Contact field that contains the day-of-month value. Must include 'record.' prefix (e.g., record.birthday_day).",
                "maxLength": 262144
              },
              "month_field": {
                "type": "string",
                "description": "Contact field that contains the month value. Must include 'record.' prefix (e.g., record.birthday_month).",
                "maxLength": 262144
              },
              "type": {
                "type": "string",
                "description": "Where the date is represented (e.g., Profile).",
                "maxLength": 262144
              }
            },
            "additionalProperties": false
          },
          "type": {
            "type": "string",
            "description": "Trigger type. Determines how the trigger is evaluated (e.g., Action, Date, segment_join).",
            "maxLength": 262144
          },
          "unique_by": {
            "type": "string",
            "description": "Deduplication key: run the workflow at most once per contact per this value (e.g., list_ids, contact_id).",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "ParameterDto": {
        "type": "object",
        "description": "A single trigger parameter used to filter or configure the trigger (e.g., list IDs). Use parameter_value (preferred); parameter_string_value and parameter_list_value are supported for backwards compatibility.",
        "properties": {
          "operator": {
            "type": "string",
            "description": "Comparison operator for the parameter (e.g. EQUALS, CONTAINS, NOT_EQUALS).",
            "maxLength": 262144
          },
          "parameter_name": {
            "type": "string",
            "description": "Name of the parameter (e.g., list_ids, create_source, url).",
            "maxLength": 262144
          },
          "parameter_list_value": {
            "type": "array",
            "description": "[DEPRECATED] List of string values for the parameter when type is LIST. Supported for backwards compatibility; prefer parameter_value.",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "parameter_string_value": {
            "type": "string",
            "description": "[DEPRECATED] String value for the parameter when type is STRING. Supported for backwards compatibility; prefer parameter_value.",
            "maxLength": 262144
          },
          "parameter_value": {
            "type": "object",
            "description": "The parameter value: a string or array of strings depending on type (e.g., STRING → single value, LIST → array of list IDs). Use this instead of parameter_string_value / parameter_list_value moving forward.",
            "properties": {},
            "additionalProperties": true
          },
          "rule": {
            "type": "object",
            "description": "Rule structure for RULE-type parameters (e.g., engagement level triggers).",
            "properties": {},
            "additionalProperties": true
          },
          "type": {
            "type": "string",
            "description": "Parameter type. Common trigger types: STRING (single value), LIST (array), WEB_TRACKING (page visit).",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "AutomationCampaignUpdate": {
        "type": "object",
        "properties": {
          "automation_flow": {
            "$ref": "#/$defs/AutomationCampaign"
          }
        },
        "additionalProperties": false
      },
      "AutomationCampaign": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "The unique identifier for the automation campaign workflow.",
            "maxLength": 262144
          },
          "name": {
            "type": "string",
            "description": "The name of the automation campaign.",
            "maxLength": 262144
          },
          "description": {
            "type": "string",
            "description": "The description of the automation campaign.",
            "maxLength": 262144
          },
          "structured_tags": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/AutomationStructuredTag"
            },
            "maxItems": 10
          },
          "status": {
            "type": "string",
            "enum": [
              "ACTIVE",
              "DRAFT",
              "ENDED",
              "DELETED",
              "ACTIVE_WITH_DISABLED_TRIGGER",
              "UNKNOWN"
            ],
            "description": "Computed display status of the workflow",
            "maxLength": 262144
          },
          "active_definition": {
            "$ref": "#/$defs/AutomationWorkflowDefinition"
          },
          "draft_definition": {
            "$ref": "#/$defs/AutomationWorkflowDefinition"
          },
          "name_explicitly_set": {
            "type": "boolean",
            "description": "Indicates whether the automation campaign name was explicitly set."
          }
        },
        "additionalProperties": false
      },
      "AutomationStructuredTag": {
        "type": "object",
        "description": "A structured tag with key, value, and display value",
        "properties": {
          "display_value": {
            "type": "string",
            "description": "Human-readable display value",
            "maxLength": 262144
          },
          "key": {
            "type": "string",
            "description": "Tag key",
            "maxLength": 262144
          },
          "value": {
            "type": "string",
            "description": "Tag value",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "AutomationWorkflowDefinition": {
        "type": "object",
        "description": "A workflow definition containing state, trigger, and workflow structure.",
        "properties": {
          "state": {
            "type": "string",
            "description": "The current state of the workflow definition (e.g. DRAFT, ACTIVE).",
            "maxLength": 262144
          },
          "trigger": {
            "$ref": "#/$defs/TriggerDto"
          },
          "workflow": {
            "$ref": "#/$defs/AutomationFlow"
          }
        },
        "additionalProperties": false
      },
      "TriggerDto": {
        "type": "object",
        "properties": {
          "trigger_def": {
            "$ref": "#/$defs/TriggerDefDto"
          },
          "trigger_filter": {
            "$ref": "#/$defs/TriggerFilterDto"
          },
          "trigger_version": {
            "type": "string",
            "maxLength": 262144
          },
          "workflow_filter": {
            "type": "string",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "TriggerFilterDto": {
        "type": "object",
        "properties": {
          "rule": {
            "$ref": "#/$defs/TriggerFilterRuleDto"
          },
          "version": {
            "type": "string",
            "description": "Version number for the trigger filter.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "TriggerFilterRuleDto": {
        "type": "object",
        "properties": {
          "compound_rule_type": {
            "type": "string",
            "maxLength": 262144
          },
          "left": {
            "$ref": "#/$defs/TriggerFilterRuleDto"
          },
          "property_comparison": {
            "$ref": "#/$defs/PropertyComparisonDto"
          },
          "right": {
            "$ref": "#/$defs/TriggerFilterRuleDto"
          },
          "rule": {
            "$ref": "#/$defs/TriggerFilterRuleDto"
          },
          "target": {
            "type": "string",
            "maxLength": 262144
          },
          "target_type": {
            "type": "string",
            "maxLength": 262144
          },
          "type": {
            "type": "string",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "PropertyComparisonDto": {
        "type": "object",
        "properties": {
          "argument": {
            "type": "string",
            "maxLength": 262144
          },
          "array_argument": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 262144
            },
            "maxItems": 10
          },
          "operator": {
            "type": "string",
            "maxLength": 262144
          },
          "property_name": {
            "type": "string",
            "maxLength": 262144
          },
          "string_map_argument": {
            "type": "object",
            "properties": {
              "custom_field_Id": {
                "type": "string",
                "maxLength": 262144
              },
              "value": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "additionalProperties": false
          },
          "type": {
            "type": "string",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "AutomationFlow": {
        "type": "object",
        "description": "The workflow flow definition.",
        "properties": {
          "workflow_def": {
            "$ref": "#/$defs/AutomationWorkflowDef"
          }
        },
        "additionalProperties": false
      },
      "AutomationWorkflowDef": {
        "type": "object",
        "description": "The workflow definition containing tasks, status, and metadata.",
        "properties": {
          "parameters": {
            "$ref": "#/$defs/WorkflowParametersDto"
          },
          "correlation_metadata": {
            "$ref": "#/$defs/CorrelationMetadataDto"
          },
          "tasks": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TaskDto"
            },
            "maxItems": 10
          },
          "status": {
            "type": "string",
            "description": "Workflow definition status.",
            "maxLength": 262144
          },
          "metadata": {
            "type": "object",
            "description": "Workflow metadata.",
            "properties": {},
            "additionalProperties": true
          },
          "timeout": {
            "$ref": "#/$defs/TimeoutDto"
          },
          "upgradable": {
            "type": "boolean",
            "description": "Indicates if the workflow can be upgraded after it is activated."
          }
        },
        "additionalProperties": false
      },
      "WorkflowParametersDto": {
        "type": "object",
        "properties": {
          "automation_flow_id": {
            "type": "string",
            "description": "Automation flow identifier",
            "maxLength": 262144
          },
          "automation_flow_name": {
            "type": "string",
            "description": "Automation flow name",
            "maxLength": 262144
          },
          "campaign_id": {
            "type": "string",
            "description": "Automation campaign identifier",
            "maxLength": 262144
          },
          "discount_code": {
            "type": "string",
            "description": "Discount code used in discount block",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "CorrelationMetadataDto": {
        "type": "object",
        "properties": {
          "automation_flow_id": {
            "type": "string",
            "description": "Automation flow identifier",
            "maxLength": 262144
          },
          "automation_template_id": {
            "type": "string",
            "description": "Automation template identifier",
            "maxLength": 262144
          },
          "campaign_id": {
            "type": "string",
            "description": "Automation campaign identifier",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "TaskDto": {
        "type": "object",
        "properties": {
          "child_tasks": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TaskDto"
            },
            "maxItems": 10
          },
          "correlation_metadata": {
            "$ref": "#/$defs/TaskCorrelationMetadataDto"
          },
          "else": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TaskDto"
            },
            "maxItems": 10
          },
          "event_condition": {
            "type": "string",
            "maxLength": 262144
          },
          "id": {
            "type": "string",
            "maxLength": 262144
          },
          "input": {
            "type": "object",
            "description": "Task input object",
            "additionalProperties": {
              "type": "string",
              "maxLength": 262144
            }
          },
          "json_condition": {
            "type": "object",
            "properties": {},
            "additionalProperties": true
          },
          "kind": {
            "type": "string",
            "description": "Task type.",
            "maxLength": 262144
          },
          "metadata": {
            "type": "object",
            "description": "Task metadata object.",
            "properties": {
              "action": {
                "type": "string",
                "maxLength": 262144
              },
              "create_from_scratch": {
                "type": "boolean"
              },
              "kind": {
                "type": "string",
                "maxLength": 262144
              },
              "list": {
                "type": "string",
                "maxLength": 262144
              }
            },
            "additionalProperties": false
          },
          "name": {
            "type": "string",
            "description": "Task name.",
            "maxLength": 262144
          },
          "output": {
            "type": "object",
            "properties": {},
            "additionalProperties": true
          },
          "queue_name": {
            "type": "string",
            "maxLength": 262144
          },
          "retry_options": {
            "type": "object",
            "properties": {
              "backoff_coefficient": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "initial_interval": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "maximum_attempts": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": false
          },
          "script": {
            "type": "string",
            "maxLength": 262144
          },
          "task_provider_reference_key": {
            "type": "string",
            "maxLength": 262144
          },
          "task_skip_condition": {
            "type": "string",
            "maxLength": 262144
          },
          "then": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TaskDto"
            },
            "maxItems": 10
          },
          "timeout": {
            "$ref": "#/$defs/TimeoutDto"
          }
        },
        "additionalProperties": false
      },
      "TaskCorrelationMetadataDto": {
        "type": "object",
        "properties": {
          "campaign_activity_id": {
            "type": "string",
            "description": "Campaign activity identifier",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "TimeoutDto": {
        "type": "object",
        "properties": {
          "amount": {
            "type": "number",
            "description": "Amount of time for startup timeout."
          },
          "time_unit": {
            "type": "string",
            "description": "Unit of time for startup timeout.",
            "maxLength": 262144
          }
        },
        "additionalProperties": false
      },
      "ABTestData": {
        "type": "object",
        "required": [
          "alternative_subject",
          "test_size",
          "winner_wait_duration"
        ],
        "properties": {
          "alternative_subject": {
            "type": "string",
            "description": "The alternate email subject line to use for A/B testing.",
            "maxLength": 262144
          },
          "test_size": {
            "type": "integer",
            "description": "The percentage of contact recipients to participate in the A/B Test. For example, if the value is 30, then 30% of contacts will receive the email campaign with subject line A, and 30% of contacts will receive the email campaign with subject line B. Valid values include 5 to 50 percent. Currently, A/B tests support subject line only.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "winner_wait_duration": {
            "type": "integer",
            "enum": [
              6,
              12,
              24,
              48
            ],
            "description": "The number of hours Constant Contact waits after the A/B test is sent before determining the winning subject line. The winner is the subject line with the highest number of contact opens. Valid values include 6 , 12 , 24 , and 48 . After the winner is determined, Constant Contact automatically sends the email campaign with the winning subject line to all the remaining contacts, which did not participate in the A/B test.",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "additionalProperties": false
      }
    },
    "D": {
      "ContactDelete": {
        "type": "object",
        "properties": {
          "contact_ids": {
            "type": "array",
            "maxItems": 10,
            "description": "Specify up to 500 contacts by contact_id to delete; mutually exclusive with list_ids .",
            "items": {
              "type": "string",
              "maxLength": 262144
            }
          },
          "list_ids": {
            "type": "array",
            "maxItems": 10,
            "description": "The contacts on the lists (up to 50) specified will be deleted; mutually exclusive with contact_ids .",
            "items": {
              "type": "string",
              "maxLength": 262144
            }
          }
        },
        "additionalProperties": false
      },
      "ListActivityRemoveContacts": {
        "type": "object",
        "required": [
          "list_ids",
          "source"
        ],
        "properties": {
          "source": {
            "type": "object",
            "description": "Specifies the contacts to remove from your target list(s) using one of several mutually exclusive properties.",
            "properties": {
              "list_ids": {
                "type": "array",
                "maxItems": 0,
                "description": "Include up to 50 list_id values to remove all contact list members from your target list(s). This property is mutually exclusive with all other source properties.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "contact_ids": {
                "type": "array",
                "maxItems": 0,
                "description": "Include up to 500 contact_id values to remove the contacts from your target lists. This property is mutually exclusive with all other source properties.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "all_active_contacts": {
                "type": "boolean",
                "description": "Removes all active (billable) contacts from your targeted lists. This property is mutually exclusive with all other source properties."
              },
              "engagement_level": {
                "type": "string",
                "enum": [
                  "unqualified",
                  "low",
                  "medium",
                  "high"
                ],
                "description": "Removes all contacts that meet the selected engagement_level to your target lists. This property is mutually exclusive with all other source properties.",
                "maxLength": 262144
              },
              "tag_ids": {
                "type": "array",
                "maxItems": 0,
                "description": "Removes all contacts assigned with the specified tag_id s from your target lists. This property is mutually exclusive with all other source properties.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              }
            },
            "additionalProperties": false
          },
          "exclude": {
            "type": "object",
            "properties": {
              "contact_ids": {
                "type": "array",
                "description": "Excludes specified contacts ( contact_id ) from being deleted from the target list and only applicable if using either the all_active_contacts (billable) or list_ids as the source.",
                "items": {
                  "type": "string",
                  "description": "An array of contact_id s to exclude.",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false
          },
          "list_ids": {
            "type": "array",
            "maxItems": 0,
            "description": "Specify up to 50 target list_id s from which to remove contacts.",
            "items": {
              "type": "string",
              "description": "Target list from which to remove contacts.",
              "maxLength": 262144
            }
          }
        },
        "additionalProperties": false
      },
      "ListIdList100": {
        "type": "object",
        "required": [
          "list_ids"
        ],
        "properties": {
          "list_ids": {
            "type": "array",
            "maxItems": 10,
            "description": "The array of contact lists list_id to delete.",
            "items": {
              "type": "string",
              "maxLength": 262144
            }
          }
        },
        "additionalProperties": false
      },
      "TagAddRemoveContacts": {
        "type": "object",
        "required": [
          "source",
          "tag_ids"
        ],
        "properties": {
          "source": {
            "type": "object",
            "description": "Select the source used to identify contacts to which a tag is added or removed. Source types are mutually exclusive.",
            "properties": {
              "contact_ids": {
                "type": "array",
                "maxItems": 10,
                "description": "An array of contacts IDs.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "list_ids": {
                "type": "array",
                "maxItems": 10,
                "description": "An array of list IDs ( list_id ).",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "tag_ids": {
                "type": "array",
                "maxItems": 10,
                "description": "An array of tags ( tag_id ).",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                }
              },
              "all_active_contacts": {
                "type": "boolean",
                "description": "Use to identify contacts with an active (billable) status."
              },
              "new_subscriber": {
                "type": "boolean",
                "description": "Use to identify newly subscribed contacts."
              }
            },
            "additionalProperties": false
          },
          "exclude": {
            "type": "object",
            "description": "Use to exclude specified contacts from being added or removed from a tag. Only applicable if the specified source is either all_active_contacts (billable) or list_ids .",
            "properties": {
              "contact_ids": {
                "type": "array",
                "description": "Identifies the contacts, by contact_id , to exclude from the add or remove tags activity.",
                "items": {
                  "type": "string",
                  "maxLength": 262144
                },
                "maxItems": 10
              }
            },
            "additionalProperties": false
          },
          "tag_ids": {
            "type": "array",
            "maxItems": 10,
            "description": "An array of tags ( tag_id ) to add to all contacts meeting the specified source criteria.",
            "items": {
              "type": "string",
              "description": "A list of tags to which contacts are added or removed.",
              "maxLength": 262144
            }
          }
        },
        "additionalProperties": false
      },
      "TagIdList500Limit": {
        "type": "object",
        "required": [
          "tag_ids"
        ],
        "properties": {
          "tag_ids": {
            "type": "array",
            "maxItems": 10,
            "description": "The tag IDs ( tag_ids ) to delete.",
            "items": {
              "type": "string",
              "description": "A list of tag_ids. Mutually exclusive with other filters and criteria.",
              "maxLength": 262144
            }
          }
        },
        "additionalProperties": false
      },
      "CustomFieldId100": {
        "type": "object",
        "required": [
          "custom_field_ids"
        ],
        "properties": {
          "custom_field_ids": {
            "type": "array",
            "maxItems": 0,
            "description": "The array of custom field IDs to delete.",
            "items": {
              "type": "string",
              "maxLength": 262144
            }
          }
        },
        "additionalProperties": false
      }
    },
    "output": {
      "UserPrivilegesResource": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "privilege_id": {
              "type": "integer"
            },
            "privilege_name": {
              "type": "string"
            }
          },
          "additionalProperties": true
        }
      },
      "Customer": {
        "type": "object",
        "properties": {
          "contact_email": {
            "type": "string"
          },
          "contact_phone": {
            "type": "string"
          },
          "country_code": {
            "type": "string"
          },
          "encoded_account_id": {
            "type": "string"
          },
          "encoded_partner_id": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "organization_name": {
            "type": "string"
          },
          "organization_phone": {
            "type": "string"
          },
          "state_code": {
            "type": "string"
          },
          "time_zone_id": {
            "type": "string"
          },
          "website": {
            "type": "string"
          },
          "physical_address": {
            "type": "object",
            "required": [
              "address_line1",
              "city",
              "country_code"
            ],
            "properties": {
              "address_line1": {
                "type": "string"
              },
              "address_line2": {
                "type": "string"
              },
              "address_line3": {
                "type": "string"
              },
              "city": {
                "type": "string"
              },
              "state_code": {
                "type": "string"
              },
              "state_name": {
                "type": "string"
              },
              "postal_code": {
                "type": "string"
              },
              "country_code": {
                "type": "string"
              }
            },
            "additionalProperties": true
          },
          "company_logo": {
            "$ref": "#/$defs/CompanyLogo"
          }
        },
        "additionalProperties": true
      },
      "CompanyLogo": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string"
          },
          "external_url": {
            "type": "string"
          },
          "internal_id": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "AccountPhysicalAddress": {
        "type": "object",
        "required": [
          "address_line1",
          "city",
          "country_code"
        ],
        "properties": {
          "address_line1": {
            "type": "string"
          },
          "address_line2": {
            "type": "string"
          },
          "address_line3": {
            "type": "string"
          },
          "city": {
            "type": "string"
          },
          "state_code": {
            "type": "string"
          },
          "state_name": {
            "type": "string"
          },
          "postal_code": {
            "type": "string"
          },
          "country_code": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "AccountEmails": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "email_address": {
              "type": "string"
            },
            "email_id": {
              "type": "integer"
            },
            "confirm_status": {
              "type": "string"
            },
            "confirm_time": {
              "type": "string"
            },
            "confirm_source_type": {
              "type": "string"
            },
            "roles": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "pending_roles": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "additionalProperties": true
        }
      },
      "Activities": {
        "type": "object",
        "properties": {
          "activities": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "activity_id": {
                  "type": "string"
                },
                "state": {
                  "type": "string"
                },
                "started_at": {
                  "type": "string"
                },
                "completed_at": {
                  "type": "string"
                },
                "created_at": {
                  "type": "string"
                },
                "updated_at": {
                  "type": "string"
                },
                "source_file_name": {
                  "type": "string"
                },
                "percent_done": {
                  "type": "integer"
                },
                "activity_errors": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "status": {
                  "$ref": "#/$defs/ActivityStatus"
                },
                "_links": {
                  "$ref": "#/$defs/ActivityStatusExportLink"
                }
              },
              "additionalProperties": true
            }
          },
          "_links": {
            "$ref": "#/$defs/PagingLinks"
          }
        },
        "additionalProperties": true
      },
      "ActivityStatus": {
        "type": "object",
        "properties": {
          "items_total_count": {
            "type": "integer"
          },
          "items_completed_count": {
            "type": "integer"
          },
          "person_count": {
            "type": "integer"
          },
          "error_count": {
            "type": "integer"
          },
          "correctable_count": {
            "type": "integer"
          },
          "cannot_add_to_list_count": {
            "type": "integer"
          },
          "list_count": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "ActivityStatusExportLink": {
        "type": "object",
        "properties": {
          "self": {
            "type": "object",
            "properties": {
              "href": {
                "type": "string"
              }
            },
            "additionalProperties": true
          },
          "results": {
            "type": "object",
            "properties": {
              "href": {
                "type": "string"
              }
            },
            "additionalProperties": true
          }
        },
        "additionalProperties": true
      },
      "PagingLinks": {
        "type": "object",
        "properties": {
          "next": {
            "$ref": "#/$defs/Link"
          }
        },
        "additionalProperties": true
      },
      "Link": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "Activity": {
        "type": "object",
        "properties": {
          "activity_id": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "started_at": {
            "type": "string"
          },
          "completed_at": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "source_file_name": {
            "type": "string"
          },
          "percent_done": {
            "type": "integer"
          },
          "activity_errors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "status": {
            "$ref": "#/$defs/ActivityStatus"
          },
          "_links": {
            "$ref": "#/$defs/ActivityStatusExportLink"
          }
        },
        "additionalProperties": true
      },
      "ActivityExportStatus": {
        "type": "object",
        "properties": {
          "activity_id": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "started_at": {
            "type": "string"
          },
          "completed_at": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "percent_done": {
            "type": "integer"
          },
          "activity_errors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "status": {
            "type": "object",
            "properties": {
              "items_total_count": {
                "type": "integer"
              },
              "items_completed_count": {
                "type": "integer"
              }
            },
            "additionalProperties": true
          },
          "_links": {
            "$ref": "#/$defs/ActivityStatusExportLink"
          }
        },
        "additionalProperties": true
      },
      "ActivityDeleteStatus": {
        "type": "object",
        "properties": {
          "activity_id": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "started_at": {
            "type": "string"
          },
          "completed_at": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "percent_done": {
            "type": "integer"
          },
          "activity_errors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "status": {
            "type": "object",
            "properties": {
              "list_count": {
                "type": "integer"
              },
              "items_total_count": {
                "type": "integer"
              },
              "items_completed_count": {
                "type": "integer"
              }
            },
            "additionalProperties": true
          },
          "_links": {
            "type": "object",
            "properties": {
              "self": {
                "type": "object",
                "properties": {
                  "href": {
                    "type": "string"
                  }
                },
                "additionalProperties": true
              }
            },
            "additionalProperties": true
          }
        },
        "additionalProperties": true
      },
      "ActivityImport": {
        "type": "object",
        "properties": {
          "activity_id": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "started_at": {
            "type": "string"
          },
          "completed_at": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "source_file_name": {
            "type": "string"
          },
          "percent_done": {
            "type": "integer"
          },
          "activity_errors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "status": {
            "type": "object",
            "properties": {
              "items_total_count": {
                "type": "integer"
              },
              "person_count": {
                "type": "integer"
              },
              "error_count": {
                "type": "integer"
              },
              "correctable_count": {
                "type": "integer"
              },
              "cannot_add_to_list_count": {
                "type": "integer"
              }
            },
            "additionalProperties": true
          },
          "_links": {
            "$ref": "#/$defs/ActivityStatusLink"
          }
        },
        "additionalProperties": true
      },
      "ActivityStatusLink": {
        "type": "object",
        "properties": {
          "self": {
            "type": "object",
            "properties": {
              "href": {
                "type": "string"
              }
            },
            "additionalProperties": true
          }
        },
        "additionalProperties": true
      },
      "ActivityListsMembership": {
        "type": "object",
        "properties": {
          "activity_id": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "started_at": {
            "type": "string"
          },
          "completed_at": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "percent_done": {
            "type": "integer"
          },
          "activity_errors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "status": {
            "type": "object",
            "properties": {
              "items_total_count": {
                "type": "integer"
              },
              "items_completed_count": {
                "type": "integer"
              },
              "list_count": {
                "type": "integer"
              }
            },
            "additionalProperties": true
          },
          "_links": {
            "$ref": "#/$defs/ActivityStatusLink"
          }
        },
        "additionalProperties": true
      },
      "ActivityDeleteListsResponse": {
        "type": "object",
        "properties": {
          "activity_id": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "started_at": {
            "type": "string"
          },
          "completed_at": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "percent_done": {
            "type": "integer"
          },
          "activity_errors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "status": {
            "type": "object",
            "properties": {
              "list_count": {
                "type": "integer"
              }
            },
            "additionalProperties": true
          },
          "_links": {
            "type": "object",
            "properties": {
              "self": {
                "type": "object",
                "properties": {
                  "href": {
                    "type": "string"
                  }
                },
                "additionalProperties": true
              }
            },
            "additionalProperties": true
          }
        },
        "additionalProperties": true
      },
      "ActivityTagging": {
        "type": "object",
        "required": [
          "activity_id",
          "state"
        ],
        "properties": {
          "activity_id": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "started_at": {
            "type": "string"
          },
          "completed_at": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "percent_done": {
            "type": "integer"
          },
          "activity_errors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "status": {
            "$ref": "#/$defs/ActivityTaggingStatus"
          },
          "_links": {
            "$ref": "#/$defs/ActivityLinks"
          }
        },
        "additionalProperties": true
      },
      "ActivityTaggingStatus": {
        "type": "object",
        "properties": {
          "items_total_count": {
            "type": "integer"
          },
          "items_completed_count": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "ActivityLinks": {
        "type": "object",
        "properties": {
          "self": {
            "type": "object",
            "properties": {
              "href": {
                "type": "string"
              }
            },
            "additionalProperties": true
          },
          "results": {
            "type": "object",
            "properties": {
              "href": {
                "type": "string"
              }
            },
            "additionalProperties": true
          }
        },
        "additionalProperties": true
      },
      "ActivityDeleteCustomFields": {
        "type": "object",
        "properties": {
          "activity_id": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "started_at": {
            "type": "string"
          },
          "completed_at": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "percent_done": {
            "type": "integer"
          },
          "activity_errors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "_links": {
            "type": "object",
            "properties": {
              "self": {
                "type": "object",
                "properties": {
                  "href": {
                    "type": "string"
                  }
                },
                "additionalProperties": true
              }
            },
            "additionalProperties": true
          }
        },
        "additionalProperties": true
      },
      "PaginationDtoEventListingDto": {
        "type": "object",
        "properties": {
          "records": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/EventListingDto"
            }
          },
          "total_records": {
            "type": "integer"
          },
          "next_cursor": {
            "type": "string"
          },
          "prev_cursor": {
            "type": "string"
          },
          "_links": {
            "$ref": "#/$defs/Links"
          }
        },
        "additionalProperties": true
      },
      "EventListingDto": {
        "type": "object",
        "properties": {
          "event_id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "start_time": {
            "type": "string"
          },
          "end_time": {
            "type": "string"
          },
          "status": {
            "type": "string"
          },
          "registration_url": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "event_type": {
            "type": "string"
          },
          "location_type": {
            "type": "string"
          },
          "time_zone_type": {
            "type": "string"
          },
          "address": {
            "$ref": "#/$defs/AddressDto"
          },
          "event_registration_summary_metrics": {
            "$ref": "#/$defs/EventRegistrationSummaryMetricDto"
          },
          "create_time": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "AddressDto": {
        "type": "object",
        "required": [
          "address_type"
        ],
        "properties": {
          "address_type": {
            "type": "string"
          },
          "line1": {
            "type": "string"
          },
          "line2": {
            "type": "string"
          },
          "city": {
            "type": "string"
          },
          "country": {
            "type": "string"
          },
          "country_code": {
            "type": "string"
          },
          "create_time": {
            "type": "string"
          },
          "last_update_time": {
            "type": "string"
          },
          "latitude": {
            "type": "number"
          },
          "longitude": {
            "type": "number"
          },
          "location_name": {
            "type": "string"
          },
          "postal_code": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "state_code": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "EventRegistrationSummaryMetricDto": {
        "type": "object",
        "properties": {
          "registration_count": {
            "type": "integer"
          },
          "ticket_sold": {
            "type": "integer"
          },
          "item_sold": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "Links": {
        "type": "object",
        "properties": {
          "self": {
            "$ref": "#/$defs/Href"
          },
          "next": {
            "$ref": "#/$defs/Href"
          },
          "prev": {
            "$ref": "#/$defs/Href"
          }
        },
        "additionalProperties": true
      },
      "Href": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "EventDto": {
        "type": "object",
        "required": [
          "campaign_id",
          "default_track",
          "description",
          "event_end",
          "event_start",
          "event_type",
          "location_type",
          "name",
          "time_zone",
          "title"
        ],
        "properties": {
          "description": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "event_id": {
            "type": "string"
          },
          "campaign_id": {
            "type": "string"
          },
          "event_start": {
            "type": "string"
          },
          "event_end": {
            "type": "string"
          },
          "event_type": {
            "type": "string"
          },
          "eso": {
            "type": "string"
          },
          "contact": {
            "$ref": "#/$defs/ContactDto"
          },
          "create_time": {
            "type": "string"
          },
          "active_time": {
            "type": "string"
          },
          "cancelled_time": {
            "type": "string"
          },
          "deleted_time": {
            "type": "string"
          },
          "last_update_time": {
            "type": "string"
          },
          "address": {
            "$ref": "#/$defs/AddressDto"
          },
          "currency_type": {
            "type": "string"
          },
          "default_track": {
            "$ref": "#/$defs/TrackDto"
          },
          "display_contact_flag": {
            "type": "boolean"
          },
          "display_end_time_flag": {
            "type": "boolean"
          },
          "display_on_calendar_flag": {
            "type": "boolean"
          },
          "display_time_zone_flag": {
            "type": "boolean"
          },
          "event_calendar_url": {
            "type": "string"
          },
          "event_metadata": {
            "$ref": "#/$defs/EventMetaDataDto"
          },
          "event_code": {
            "type": "string"
          },
          "event_promotions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/EventPromotionDto"
            }
          },
          "event_settings": {
            "$ref": "#/$defs/EventSettingsDto"
          },
          "event_widget_url": {
            "type": "string"
          },
          "failed_campaign_activities": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "location_type": {
            "type": "string"
          },
          "notify_owner_on_reg": {
            "type": "boolean"
          },
          "online_meeting": {
            "$ref": "#/$defs/OnlineMeetingDto"
          },
          "registration_url": {
            "type": "string"
          },
          "status": {
            "type": "string"
          },
          "time_zone": {
            "type": "string"
          },
          "time_zone_abbreviation": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ContactDto": {
        "type": "object",
        "required": [
          "name",
          "organization_name"
        ],
        "properties": {
          "create_time": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "from_email_address": {
            "type": "string"
          },
          "last_update_time": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "organization_name": {
            "type": "string"
          },
          "phone_number": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "TrackDto": {
        "type": "object",
        "required": [
          "campaign_activity_id"
        ],
        "properties": {
          "campaign_activity_id": {
            "type": "string"
          },
          "conf_email_campaign_activity_id": {
            "type": "string"
          },
          "create_time": {
            "type": "string"
          },
          "items_header": {
            "type": "string"
          },
          "last_update_time": {
            "type": "string"
          },
          "media_assets": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/EventMediaAssetDto"
            }
          },
          "overall_ticket_capacity": {
            "type": "integer"
          },
          "platform_fee_scope_type": {
            "type": "string"
          },
          "promo_codes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/PromoCodeDto"
            }
          },
          "reg_manually_closed_flag": {
            "type": "boolean"
          },
          "registration_end_time": {
            "type": "string"
          },
          "registration_type": {
            "type": "string"
          },
          "restrict_to_single_ticket_flag": {
            "type": "boolean"
          },
          "tickets_header": {
            "type": "string"
          },
          "track_id": {
            "type": "string"
          },
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ItemDto"
            }
          }
        },
        "additionalProperties": true
      },
      "EventMediaAssetDto": {
        "type": "object",
        "properties": {
          "create_time": {
            "type": "string"
          },
          "external_id": {
            "type": "string"
          },
          "external_url": {
            "type": "string"
          },
          "internal_id": {
            "type": "string"
          },
          "last_update_time": {
            "type": "string"
          },
          "media_type": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "PromoCodeDto": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "name": {
            "type": "string"
          },
          "end_time": {
            "type": "string"
          },
          "deleted_time": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "discount_amount": {
            "type": "number"
          },
          "discount_code_scope": {
            "type": "string"
          },
          "discount_code_type": {
            "type": "string"
          },
          "discount_percent": {
            "type": "integer"
          },
          "id": {
            "type": "string"
          },
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ItemSummaryDto"
            }
          },
          "paused_flag": {
            "type": "boolean"
          },
          "quantity_available": {
            "type": "integer"
          },
          "quantity_total": {
            "type": "integer"
          },
          "quantity_used": {
            "type": "integer"
          },
          "start_time": {
            "type": "string"
          },
          "status": {
            "type": "string"
          },
          "status_labels": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StatusDisplayLabelDto"
            }
          },
          "tickets": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TicketSummaryDto"
            }
          },
          "time_limit_flag": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "ItemSummaryDto": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "associated": {
            "type": "boolean"
          },
          "display_item_on_promo_redemption": {
            "type": "boolean"
          },
          "hidden_flag": {
            "type": "boolean"
          },
          "item_id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "StatusDisplayLabelDto": {
        "type": "object",
        "properties": {
          "label": {
            "type": "string"
          },
          "label_key": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "TicketSummaryDto": {
        "type": "object",
        "required": [
          "name",
          "ticket_type"
        ],
        "properties": {
          "name": {
            "type": "string"
          },
          "ticket_id": {
            "type": "string"
          },
          "ticket_type": {
            "type": "string"
          },
          "associated": {
            "type": "boolean"
          },
          "display_ticket_on_promo_redemption": {
            "type": "boolean"
          },
          "hidden_flag": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "ItemDto": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "create_time": {
            "type": "string"
          },
          "last_update_time": {
            "type": "string"
          },
          "item_id": {
            "type": "string"
          },
          "display_order": {
            "type": "integer"
          },
          "name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "price": {
            "type": "number"
          },
          "quantity_total": {
            "type": "integer"
          },
          "quantity_remaining": {
            "type": "integer"
          },
          "quantity_sold": {
            "type": "integer"
          },
          "limit_per_order": {
            "type": "integer"
          },
          "show_remaining_flag": {
            "type": "boolean"
          },
          "paused_flag": {
            "type": "boolean"
          },
          "deletable_flag": {
            "type": "boolean"
          },
          "media_internal_id": {
            "type": "string"
          },
          "media_url": {
            "type": "string"
          },
          "time_limit_flag": {
            "type": "boolean"
          },
          "start_time": {
            "type": "string"
          },
          "end_time": {
            "type": "string"
          },
          "hidden_flag": {
            "type": "boolean"
          },
          "deleted_time": {
            "type": "string"
          },
          "status_labels": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StatusDisplayLabelDto"
            }
          },
          "attributes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/AttributeDto"
            }
          }
        },
        "additionalProperties": true
      },
      "AttributeDto": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "create_time": {
            "type": "string"
          },
          "last_update_time": {
            "type": "string"
          },
          "attribute_id": {
            "type": "string"
          },
          "display_order": {
            "type": "integer"
          },
          "name": {
            "type": "string"
          },
          "quantity_total": {
            "type": "integer"
          },
          "quantity_remaining": {
            "type": "integer"
          },
          "quantity_sold": {
            "type": "integer"
          },
          "paused_flag": {
            "type": "boolean"
          },
          "deleted_time": {
            "type": "string"
          },
          "status_labels": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StatusDisplayLabelDto"
            }
          }
        },
        "additionalProperties": true
      },
      "EventMetaDataDto": {
        "type": "object",
        "properties": {
          "items_enabled": {
            "type": "boolean"
          },
          "paid_event": {
            "type": "boolean"
          },
          "promo_codes_enabled": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "EventPromotionDto": {
        "type": "object",
        "properties": {
          "assoc_activity_sub_type": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "document_id": {
            "type": "string"
          },
          "ext_id": {
            "type": "string"
          },
          "default": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "EventSettingsDto": {
        "type": "object",
        "properties": {
          "event_requires_payments": {
            "type": "boolean"
          },
          "item_configured": {
            "type": "boolean"
          },
          "online_payment_configured": {
            "type": "boolean"
          },
          "payment_configured": {
            "type": "boolean"
          },
          "promo_code_configured": {
            "type": "boolean"
          },
          "ticket_configured": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "OnlineMeetingDto": {
        "type": "object",
        "properties": {
          "create_time": {
            "type": "string"
          },
          "enabled_flag": {
            "type": "boolean"
          },
          "instructions": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "last_update_time": {
            "type": "string"
          },
          "provider_type": {
            "type": "string"
          },
          "url": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "DetailedRegistrationDto": {
        "type": "object",
        "properties": {
          "registration_id": {
            "type": "string"
          },
          "contact_id": {
            "type": "string"
          },
          "checkedIn_tickets": {
            "type": "integer"
          },
          "checkin_status": {
            "type": "string"
          },
          "eligible_checkin_tickets": {
            "type": "integer"
          },
          "registration_date": {
            "type": "string"
          },
          "registration_status": {
            "type": "string"
          },
          "display_physical_tickets": {
            "type": "boolean"
          },
          "contact": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/SimpleFieldDto"
            }
          },
          "tickets": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/RegistrationTicketDto"
            }
          },
          "order_summary": {
            "$ref": "#/$defs/OrderDetailsDto"
          }
        },
        "additionalProperties": true
      },
      "SimpleFieldDto": {
        "type": "object",
        "properties": {
          "display_order": {
            "type": "integer"
          },
          "field_label": {
            "type": "string"
          },
          "field_name": {
            "type": "string"
          },
          "field_type": {
            "type": "string"
          },
          "label_key": {
            "type": "string"
          },
          "field_value": {
            "type": "string"
          },
          "choices": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "RegistrationTicketDto": {
        "type": "object",
        "properties": {
          "checked_in_time": {
            "type": "string"
          },
          "editable": {
            "type": "boolean"
          },
          "order_ticket_key": {
            "type": "string"
          },
          "price": {
            "type": "number"
          },
          "ticket_name": {
            "type": "string"
          },
          "fields": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/SimpleFieldDto"
            }
          }
        },
        "additionalProperties": true
      },
      "OrderDetailsDto": {
        "type": "object",
        "properties": {
          "details": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/LineItemDetailsDto"
            }
          },
          "number": {
            "type": "string"
          },
          "payment_method": {
            "type": "string"
          },
          "payment_status": {
            "type": "string"
          },
          "payment_time": {
            "type": "string"
          },
          "payment_transaction_id": {
            "type": "string"
          },
          "tickets_link": {
            "type": "string"
          },
          "tickets_text": {
            "type": "string"
          },
          "title": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "LineItemDetailsDto": {
        "type": "object",
        "properties": {
          "amount": {
            "type": "string"
          },
          "amount_unformatted": {
            "type": "number"
          },
          "line_item_type": {
            "type": "string"
          },
          "name": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "PaginatedRegistrations": {
        "type": "object",
        "properties": {
          "_links": {
            "$ref": "#/$defs/registrations_Links"
          },
          "next_cursor": {
            "type": "string"
          },
          "prev_cursor": {
            "type": "string"
          },
          "records": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/RegistrantInformationLiteDto"
            }
          },
          "total_records": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "registrations_Links": {
        "type": "object",
        "properties": {
          "next": {
            "$ref": "#/$defs/Href"
          },
          "prev": {
            "$ref": "#/$defs/Href"
          },
          "self": {
            "$ref": "#/$defs/Href"
          }
        },
        "additionalProperties": true
      },
      "RegistrantInformationLiteDto": {
        "type": "object",
        "properties": {
          "checkedIn_tickets": {
            "type": "integer"
          },
          "checkin_status": {
            "type": "string"
          },
          "eligible_checkin_tickets": {
            "type": "integer"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "new_contact": {
            "type": "boolean"
          },
          "payment_status": {
            "type": "string"
          },
          "registration_id": {
            "type": "string"
          },
          "registration_status": {
            "type": "string"
          },
          "registration_time": {
            "type": "string"
          },
          "tickets": {
            "type": "integer"
          },
          "total": {
            "type": "number"
          },
          "track_key": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "RegistrationStatusUpdateResponseDto": {
        "type": "object",
        "properties": {
          "failed_registration_ids": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "Profiles": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/ProfileDto"
        }
      },
      "ProfileDto": {
        "type": "object",
        "required": [
          "connected",
          "network",
          "profile_id"
        ],
        "properties": {
          "accessible": {
            "type": "boolean"
          },
          "account_info": {
            "$ref": "#/$defs/AccountInfoDto"
          },
          "connected": {
            "type": "boolean"
          },
          "handle": {
            "type": "string"
          },
          "image_url": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "network": {
            "type": "string"
          },
          "network_profile_id": {
            "type": "string"
          },
          "network_user_id": {
            "type": "string"
          },
          "profile_id": {
            "type": "string"
          },
          "settings": {
            "type": "object",
            "additionalProperties": {
              "type": "object",
              "properties": {},
              "additionalProperties": true
            }
          },
          "url": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "AccountInfoDto": {
        "type": "object",
        "properties": {
          "account_url": {
            "type": "string"
          },
          "display_name": {
            "type": "string"
          },
          "image_url": {
            "type": "string"
          },
          "network": {
            "type": "string"
          },
          "network_account_id": {
            "type": "string"
          },
          "username": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ConnectionResponseDto": {
        "type": "object",
        "properties": {
          "connections": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ConnectionDto"
            }
          }
        },
        "additionalProperties": true
      },
      "ConnectionDto": {
        "type": "object",
        "properties": {
          "account_info": {
            "$ref": "#/$defs/AccountInfoDto"
          },
          "connection_status": {
            "$ref": "#/$defs/ConnectionStatusDto"
          }
        },
        "additionalProperties": true
      },
      "ConnectionStatusDto": {
        "type": "object",
        "properties": {
          "error": {
            "type": "string"
          },
          "has_token": {
            "type": "boolean"
          },
          "is_active_user": {
            "type": "boolean"
          },
          "rate_limited": {
            "type": "boolean"
          },
          "status": {
            "type": "integer"
          },
          "token_has_scopes": {
            "type": "boolean"
          },
          "token_is_valid": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "PagedHashtagGroupsDto": {
        "type": "object",
        "required": [
          "_links",
          "hashtag_groups",
          "page"
        ],
        "properties": {
          "_links": {
            "$ref": "#/$defs/PagedResponseLinksDto"
          },
          "hashtag_groups": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/HashtagGroupDto"
            }
          },
          "page": {
            "$ref": "#/$defs/PageMetadataDto"
          }
        },
        "additionalProperties": true
      },
      "PagedResponseLinksDto": {
        "type": "object",
        "properties": {
          "next": {
            "$ref": "#/$defs/PagedResponseLinkRelDto"
          }
        },
        "additionalProperties": true
      },
      "PagedResponseLinkRelDto": {
        "type": "object",
        "required": [
          "href"
        ],
        "properties": {
          "href": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "HashtagGroupDto": {
        "type": "object",
        "required": [
          "hashtag_group_name",
          "hashtag_names"
        ],
        "properties": {
          "hashtag_group_id": {
            "type": "string"
          },
          "hashtag_group_name": {
            "type": "string"
          },
          "hashtag_names": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "PageMetadataDto": {
        "type": "object",
        "required": [
          "page",
          "size",
          "total_elements",
          "total_pages"
        ],
        "properties": {
          "page": {
            "type": "integer"
          },
          "size": {
            "type": "integer"
          },
          "total_elements": {
            "type": "integer"
          },
          "total_pages": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "PostDto": {
        "type": "object",
        "required": [
          "profile_posts",
          "status"
        ],
        "properties": {
          "campaign_id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "profile_posts": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ProfilePostDto"
            }
          },
          "scheduled_time": {
            "type": "string"
          },
          "status": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ProfilePostDto": {
        "type": "object",
        "required": [
          "profiles"
        ],
        "properties": {
          "images": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ImageDto"
            }
          },
          "post_content_id": {
            "type": "string"
          },
          "profiles": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ProfilePostProfileDto"
            }
          },
          "settings": {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/MapOfstringAndstring"
            }
          },
          "text": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ImageDto": {
        "type": "object",
        "required": [
          "url"
        ],
        "properties": {
          "image_id": {
            "type": "string"
          },
          "url": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ProfilePostProfileDto": {
        "type": "object",
        "required": [
          "profile_id"
        ],
        "properties": {
          "account_username": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "campaign_activity_status": {
            "type": "string"
          },
          "campaign_activity_status_date": {
            "type": "string"
          },
          "campaign_activity_status_message": {
            "type": "string"
          },
          "image_url": {
            "type": "string"
          },
          "network": {
            "type": "string"
          },
          "network_post_id": {
            "type": "string"
          },
          "post_url": {
            "type": "string"
          },
          "profile_id": {
            "type": "string"
          },
          "profile_name": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "MapOfstringAndstring": {
        "type": "object",
        "additionalProperties": {
          "type": "string"
        }
      },
      "SegmentsDTO": {
        "type": "object",
        "required": [
          "segments"
        ],
        "properties": {
          "segments": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/SegmentMaster"
            }
          },
          "_links": {
            "$ref": "#/$defs/segments_Links"
          }
        },
        "additionalProperties": true
      },
      "SegmentMaster": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "segment_id": {
            "type": "integer"
          },
          "created_at": {
            "type": "string"
          },
          "edited_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "segments_Links": {
        "type": "object",
        "required": [
          "next"
        ],
        "properties": {
          "next": {
            "$ref": "#/$defs/Next"
          }
        },
        "additionalProperties": true
      },
      "Next": {
        "type": "object",
        "required": [
          "href"
        ],
        "properties": {
          "href": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "SegmentDetail": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "segment_criteria": {
            "type": "string"
          },
          "segment_id": {
            "type": "integer"
          },
          "created_at": {
            "type": "string"
          },
          "edited_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ContactResource": {
        "type": "object",
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "email_address": {
            "$ref": "#/$defs/EmailAddress"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "job_title": {
            "type": "string"
          },
          "company_name": {
            "type": "string"
          },
          "birthday_month": {
            "type": "integer"
          },
          "birthday_day": {
            "type": "integer"
          },
          "anniversary": {
            "type": "string"
          },
          "update_source": {
            "type": "string"
          },
          "create_source": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          },
          "custom_fields": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ContactCustomField"
            }
          },
          "phone_numbers": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/PhoneNumber"
            }
          },
          "street_addresses": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StreetAddress"
            }
          },
          "list_memberships": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "taggings": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "notes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/Note"
            }
          },
          "sms_channel": {
            "type": "object",
            "properties": {
              "sms_channel_id": {
                "type": "string"
              },
              "sms_address": {
                "type": "string"
              },
              "dial_code": {
                "type": "string"
              },
              "country_code": {
                "type": "string"
              },
              "update_source": {
                "type": "string"
              },
              "create_source": {
                "type": "string"
              },
              "sms_channel_consents": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/SmsChannelConsentDetails"
                }
              }
            },
            "additionalProperties": true
          }
        },
        "additionalProperties": true
      },
      "EmailAddress": {
        "type": "object",
        "required": [
          "address"
        ],
        "properties": {
          "address": {
            "type": "string"
          },
          "permission_to_send": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "opt_in_source": {
            "type": "string"
          },
          "opt_in_date": {
            "type": "string"
          },
          "opt_out_source": {
            "type": "string"
          },
          "opt_out_date": {
            "type": "string"
          },
          "opt_out_reason": {
            "type": "string"
          },
          "confirm_status": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ContactCustomField": {
        "type": "object",
        "required": [
          "custom_field_id"
        ],
        "properties": {
          "custom_field_id": {
            "type": "string"
          },
          "value": {
            "type": "string"
          },
          "choice_ids": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": true
      },
      "PhoneNumber": {
        "type": "object",
        "properties": {
          "phone_number_id": {
            "type": "string"
          },
          "phone_number": {
            "type": "string"
          },
          "kind": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "update_source": {
            "type": "string"
          },
          "create_source": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "StreetAddress": {
        "type": "object",
        "required": [
          "kind"
        ],
        "properties": {
          "street_address_id": {
            "type": "string"
          },
          "kind": {
            "type": "string"
          },
          "street": {
            "type": "string"
          },
          "city": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "postal_code": {
            "type": "string"
          },
          "country": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "Note": {
        "type": "object",
        "properties": {
          "note_id": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "content": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "SmsChannelConsentDetails": {
        "type": "object",
        "properties": {
          "sms_consent_permission": {
            "type": "string"
          },
          "consent_type": {
            "type": "string"
          },
          "opt_in_date": {
            "type": "string"
          },
          "opt_out_date": {
            "type": "string"
          },
          "advertised_frequency": {
            "type": "string"
          },
          "advertised_interval": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "Contacts": {
        "type": "object",
        "properties": {
          "contacts": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ContactResource"
            }
          },
          "contacts_count": {
            "type": "integer"
          },
          "_links": {
            "$ref": "#/$defs/PagingLinks"
          },
          "status": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ContactCreateOrUpdateResponse": {
        "type": "object",
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "action": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ContactXrefs": {
        "type": "object",
        "properties": {
          "xrefs": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ContactXref"
            }
          }
        },
        "additionalProperties": true
      },
      "ContactXref": {
        "type": "object",
        "properties": {
          "sequence_id": {
            "type": "string"
          },
          "contact_id": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "CustomField": {
        "type": "object",
        "required": [
          "label",
          "type"
        ],
        "properties": {
          "custom_field_id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "type": {
            "type": "string"
          },
          "metadata": {
            "$ref": "#/$defs/CustomFieldMetadata"
          },
          "version": {
            "type": "integer"
          },
          "choices": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/CustomFieldChoice"
            }
          },
          "updated_at": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "CustomFieldMetadata": {
        "type": "object",
        "properties": {
          "display_type": {
            "type": "string"
          },
          "allow_negative": {
            "type": "boolean"
          },
          "decimal_places": {
            "type": "integer"
          },
          "currency_code": {
            "type": "string"
          },
          "integer": {
            "type": "boolean"
          },
          "display_format": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "CustomFieldChoice": {
        "type": "object",
        "properties": {
          "custom_field_id": {
            "type": "string"
          },
          "choice_id": {
            "type": "integer"
          },
          "choice_label": {
            "type": "string"
          },
          "display_order": {
            "type": "integer"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "CustomFields": {
        "type": "object",
        "properties": {
          "custom_fields": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/CustomField"
            }
          },
          "_links": {
            "$ref": "#/$defs/PagingLinks"
          }
        },
        "additionalProperties": true
      },
      "ContactList": {
        "type": "object",
        "required": [
          "list_id",
          "name"
        ],
        "properties": {
          "list_id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "favorite": {
            "type": "boolean"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          },
          "membership_count": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "ContactListPutPost": {
        "type": "object",
        "required": [
          "list_id",
          "name"
        ],
        "properties": {
          "list_id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "favorite": {
            "type": "boolean"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ActivityDeleteListResponse": {
        "type": "object",
        "properties": {
          "activity_id": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "percent_done": {
            "type": "integer"
          },
          "activity_errors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "_links": {
            "type": "object",
            "properties": {
              "self": {
                "type": "object",
                "properties": {
                  "href": {
                    "type": "string"
                  }
                },
                "additionalProperties": true
              }
            },
            "additionalProperties": true
          }
        },
        "additionalProperties": true
      },
      "ContactListArray": {
        "type": "object",
        "properties": {
          "lists": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ContactList"
            }
          },
          "lists_count": {
            "type": "integer"
          },
          "_links": {
            "$ref": "#/$defs/PagingLinks"
          }
        },
        "additionalProperties": true
      },
      "ListXrefs": {
        "type": "object",
        "properties": {
          "xrefs": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ListXref"
            }
          }
        },
        "additionalProperties": true
      },
      "ListXref": {
        "type": "object",
        "properties": {
          "sequence_id": {
            "type": "string"
          },
          "list_id": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "SmsEngagementHistory": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "contact_id": {
              "type": "string"
            },
            "sms_channel_id": {
              "type": "string"
            },
            "sms_channel_history_id": {
              "type": "string"
            },
            "insert_time": {
              "type": "string"
            },
            "history_details": {
              "$ref": "#/$defs/HistoryDetails"
            }
          },
          "additionalProperties": true
        }
      },
      "HistoryDetails": {
        "type": "object",
        "properties": {
          "state": {
            "type": "string"
          },
          "source": {
            "type": "string"
          },
          "consent_type": {
            "type": "string"
          },
          "consent_action_time": {
            "type": "string"
          },
          "consent_action_type": {
            "type": "string"
          },
          "consent_medium_type": {
            "type": "string"
          },
          "source_consent_timestamp": {
            "type": "string"
          },
          "source_sms_number": {
            "type": "string"
          },
          "advertised_frequency": {
            "type": "integer"
          },
          "advertised_interval": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ContactsCounts": {
        "type": "object",
        "properties": {
          "total": {
            "type": "integer"
          },
          "explicit": {
            "type": "integer"
          },
          "implicit": {
            "type": "integer"
          },
          "pending": {
            "type": "integer"
          },
          "unsubscribed": {
            "type": "integer"
          },
          "new_subscriber": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "Tag": {
        "type": "object",
        "properties": {
          "tag_id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "contacts_count": {
            "type": "integer"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "tag_source": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ActivityGeneric": {
        "type": "object",
        "required": [
          "activity_id",
          "state"
        ],
        "properties": {
          "activity_id": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "updated_at": {
            "type": "string"
          },
          "percent_done": {
            "type": "integer"
          },
          "activity_errors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ActivityErrors"
            }
          },
          "status": {
            "$ref": "#/$defs/ActivityGenericStatus"
          },
          "_links": {
            "$ref": "#/$defs/tags_ActivityLinks"
          }
        },
        "additionalProperties": true
      },
      "ActivityErrors": {
        "type": "object",
        "properties": {
          "message": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ActivityGenericStatus": {
        "type": "object",
        "properties": {
          "items_total_count": {
            "type": "integer"
          },
          "items_completed_count": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "tags_ActivityLinks": {
        "type": "object",
        "properties": {
          "self": {
            "type": "object",
            "properties": {
              "href": {
                "type": "string"
              }
            },
            "additionalProperties": true
          }
        },
        "additionalProperties": true
      },
      "Tags": {
        "type": "object",
        "properties": {
          "tags": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/Tag"
            }
          },
          "_links": {
            "$ref": "#/$defs/tags_PagingLinks"
          }
        },
        "additionalProperties": true
      },
      "tags_PagingLinks": {
        "type": "object",
        "properties": {
          "next": {
            "$ref": "#/$defs/tags_Links"
          }
        },
        "additionalProperties": true
      },
      "tags_Links": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          },
          "next": {
            "$ref": "#/$defs/reporting_Next"
          }
        },
        "additionalProperties": true
      },
      "reporting_Next": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "PagedEmailCampaignResponse": {
        "type": "object",
        "properties": {
          "_links": {
            "$ref": "#/$defs/emails_PagingLinks"
          },
          "campaigns": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/EmailCampaigns"
            }
          }
        },
        "additionalProperties": true
      },
      "emails_PagingLinks": {
        "type": "object",
        "properties": {
          "next": {
            "$ref": "#/$defs/emails_Link"
          }
        },
        "additionalProperties": true
      },
      "emails_Link": {
        "type": "object",
        "properties": {
          "href": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "EmailCampaigns": {
        "type": "object",
        "properties": {
          "campaign_id": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "current_status": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "type": {
            "type": "string"
          },
          "type_code": {
            "type": "integer"
          },
          "updated_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "EmailCampaign": {
        "type": "object",
        "properties": {
          "campaign_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ActivityReference"
            }
          },
          "campaign_id": {
            "type": "string"
          },
          "created_at": {
            "type": "string"
          },
          "current_status": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "type": {
            "type": "string"
          },
          "type_code": {
            "type": "integer"
          },
          "updated_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ActivityReference": {
        "type": "object",
        "properties": {
          "campaign_activity_id": {
            "type": "string"
          },
          "role": {
            "type": "string"
          },
          "document_id": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "CrossReferenceResponse": {
        "type": "object",
        "properties": {
          "xrefs": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/CrossReference"
            }
          }
        },
        "additionalProperties": true
      },
      "CrossReference": {
        "type": "object",
        "properties": {
          "v2_email_campaign_id": {
            "type": "string"
          },
          "campaign_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "EmailCampaignActivity": {
        "type": "object",
        "required": [
          "from_email",
          "from_name",
          "reply_to_email",
          "subject"
        ],
        "properties": {
          "campaign_activity_id": {
            "type": "string"
          },
          "campaign_id": {
            "type": "string"
          },
          "role": {
            "type": "string"
          },
          "contact_list_ids": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "segment_ids": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          },
          "current_status": {
            "type": "string"
          },
          "format_type": {
            "type": "integer"
          },
          "from_email": {
            "type": "string"
          },
          "from_name": {
            "type": "string"
          },
          "reply_to_email": {
            "type": "string"
          },
          "subject": {
            "type": "string"
          },
          "html_content": {
            "type": "string"
          },
          "permalink_url": {
            "type": "string"
          },
          "preheader": {
            "type": "string"
          },
          "physical_address_in_footer": {
            "$ref": "#/$defs/EmailPhysicalAddress"
          },
          "document_id": {
            "type": "string"
          },
          "document_properties": {
            "type": "object",
            "properties": {
              "style_content": {
                "type": "string"
              },
              "letter_format": {
                "type": "string"
              },
              "greeting_salutation": {
                "type": "string"
              },
              "greeting_name_type": {
                "type": "string"
              },
              "greeting_secondary": {
                "type": "string"
              },
              "subscribe_link_enabled": {
                "type": "string"
              },
              "subscribe_link_name": {
                "type": "string"
              },
              "text_content": {
                "type": "string"
              },
              "permission_reminder_enabled": {
                "type": "string"
              },
              "permission_reminder": {
                "type": "string"
              },
              "view_as_webpage_enabled": {
                "type": "string"
              },
              "view_as_webpage_text": {
                "type": "string"
              },
              "view_as_webpage_link_name": {
                "type": "string"
              },
              "forward_email_link_enabled": {
                "type": "string"
              },
              "forward_email_link_name": {
                "type": "string"
              }
            },
            "additionalProperties": true
          }
        },
        "additionalProperties": true
      },
      "EmailPhysicalAddress": {
        "type": "object",
        "required": [
          "address_line1",
          "country_code",
          "organization_name"
        ],
        "properties": {
          "address_line1": {
            "type": "string"
          },
          "address_line2": {
            "type": "string"
          },
          "address_line3": {
            "type": "string"
          },
          "address_optional": {
            "type": "string"
          },
          "city": {
            "type": "string"
          },
          "country_code": {
            "type": "string"
          },
          "country_name": {
            "type": "string"
          },
          "organization_name": {
            "type": "string"
          },
          "postal_code": {
            "type": "string"
          },
          "state_code": {
            "type": "string"
          },
          "state_name": {
            "type": "string"
          },
          "state_non_us_name": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "EmailScheduleResponse": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "scheduled_date": {
              "type": "string"
            }
          },
          "additionalProperties": true
        }
      },
      "EmailCampaignActivityPreview": {
        "type": "object",
        "properties": {
          "campaign_activity_id": {
            "type": "string"
          },
          "from_email": {
            "type": "string"
          },
          "from_name": {
            "type": "string"
          },
          "preheader": {
            "type": "string"
          },
          "preview_html_content": {
            "type": "string"
          },
          "preview_text_content": {
            "type": "string"
          },
          "reply_to_email": {
            "type": "string"
          },
          "subject": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "EmailSendHistory": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "send_id": {
              "type": "integer"
            },
            "contact_list_ids": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "segment_ids": {
              "type": "array",
              "items": {
                "type": "integer"
              }
            },
            "count": {
              "type": "integer"
            },
            "run_date": {
              "type": "string"
            },
            "send_status": {
              "type": "string"
            },
            "reason_code": {
              "type": "integer"
            }
          },
          "additionalProperties": true
        }
      },
      "ResendToNonOpeners": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "resend_subject": {
              "type": "string"
            },
            "delay_days": {
              "type": "integer"
            },
            "delay_minutes": {
              "type": "integer"
            },
            "resend_date": {
              "type": "string"
            },
            "resend_request_id": {
              "type": "string"
            },
            "resend_status": {
              "type": "string"
            }
          },
          "additionalProperties": true
        }
      },
      "ResendToNonOpenersObject": {
        "type": "object",
        "properties": {
          "resend_subject": {
            "type": "string"
          },
          "delay_days": {
            "type": "integer"
          },
          "delay_minutes": {
            "type": "integer"
          },
          "resend_date": {
            "type": "string"
          },
          "resend_request_id": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ListAutomationFlowsResponseDto": {
        "type": "object",
        "properties": {
          "flow_summaries": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/AutomationFlowSummaryDto"
            }
          }
        },
        "additionalProperties": true
      },
      "AutomationFlowSummaryDto": {
        "type": "object",
        "properties": {
          "active_state": {
            "type": "string"
          },
          "created_by_id": {
            "type": "string"
          },
          "created_date": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "draft_state": {
            "type": "string"
          },
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "promoted_by_id": {
            "type": "string"
          },
          "promoted_date": {
            "type": "string"
          },
          "status": {
            "type": "string"
          },
          "structured_tags": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StructuredTagDto"
            }
          },
          "template_id": {
            "type": "string"
          },
          "update_date": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "StructuredTagDto": {
        "type": "object",
        "properties": {
          "display_value": {
            "type": "string"
          },
          "key": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "AutomationCampaign": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "structured_tags": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/AutomationStructuredTag"
            }
          },
          "status": {
            "type": "string"
          },
          "active_definition": {
            "$ref": "#/$defs/AutomationWorkflowDefinition"
          },
          "draft_definition": {
            "$ref": "#/$defs/AutomationWorkflowDefinition"
          },
          "name_explicitly_set": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "AutomationStructuredTag": {
        "type": "object",
        "properties": {
          "display_value": {
            "type": "string"
          },
          "key": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "AutomationWorkflowDefinition": {
        "type": "object",
        "properties": {
          "state": {
            "type": "string"
          },
          "trigger": {
            "$ref": "#/$defs/TriggerDto"
          },
          "workflow": {
            "$ref": "#/$defs/AutomationFlow"
          }
        },
        "additionalProperties": true
      },
      "TriggerDto": {
        "type": "object",
        "properties": {
          "trigger_def": {
            "$ref": "#/$defs/TriggerDefDto"
          },
          "trigger_filter": {
            "$ref": "#/$defs/TriggerFilterDto"
          },
          "trigger_version": {
            "type": "string"
          },
          "workflow_filter": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "TriggerDefDto": {
        "type": "object",
        "properties": {
          "parameters": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ParameterDto"
            }
          },
          "action_name": {
            "type": "string"
          },
          "bounds": {
            "type": "object",
            "properties": {
              "after": {
                "type": "string"
              },
              "before": {
                "type": "string"
              }
            },
            "additionalProperties": true
          },
          "engagement_level": {
            "type": "string"
          },
          "segment_id": {
            "type": "string"
          },
          "trigger_date": {
            "type": "object",
            "properties": {
              "date_field": {
                "type": "string"
              },
              "day_field": {
                "type": "string"
              },
              "month_field": {
                "type": "string"
              },
              "type": {
                "type": "string"
              }
            },
            "additionalProperties": true
          },
          "type": {
            "type": "string"
          },
          "unique_by": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ParameterDto": {
        "type": "object",
        "properties": {
          "operator": {
            "type": "string"
          },
          "parameter_name": {
            "type": "string"
          },
          "parameter_list_value": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "parameter_string_value": {
            "type": "string"
          },
          "parameter_value": {
            "type": "object",
            "properties": {},
            "additionalProperties": true
          },
          "rule": {
            "type": "object",
            "properties": {},
            "additionalProperties": true
          },
          "type": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "TriggerFilterDto": {
        "type": "object",
        "properties": {
          "rule": {
            "$ref": "#/$defs/TriggerFilterRuleDto"
          },
          "version": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "TriggerFilterRuleDto": {
        "type": "object",
        "properties": {
          "compound_rule_type": {
            "type": "string"
          },
          "left": {
            "$ref": "#/$defs/TriggerFilterRuleDto"
          },
          "property_comparison": {
            "$ref": "#/$defs/PropertyComparisonDto"
          },
          "right": {
            "$ref": "#/$defs/TriggerFilterRuleDto"
          },
          "rule": {
            "$ref": "#/$defs/TriggerFilterRuleDto"
          },
          "target": {
            "type": "string"
          },
          "target_type": {
            "type": "string"
          },
          "type": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "PropertyComparisonDto": {
        "type": "object",
        "properties": {
          "argument": {
            "type": "string"
          },
          "array_argument": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "operator": {
            "type": "string"
          },
          "property_name": {
            "type": "string"
          },
          "string_map_argument": {
            "type": "object",
            "properties": {
              "custom_field_Id": {
                "type": "string"
              },
              "value": {
                "type": "string"
              }
            },
            "additionalProperties": true
          },
          "type": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "AutomationFlow": {
        "type": "object",
        "properties": {
          "workflow_def": {
            "$ref": "#/$defs/AutomationWorkflowDef"
          }
        },
        "additionalProperties": true
      },
      "AutomationWorkflowDef": {
        "type": "object",
        "properties": {
          "parameters": {
            "$ref": "#/$defs/WorkflowParametersDto"
          },
          "correlation_metadata": {
            "$ref": "#/$defs/CorrelationMetadataDto"
          },
          "tasks": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TaskDto"
            }
          },
          "status": {
            "type": "string"
          },
          "metadata": {
            "type": "object",
            "properties": {},
            "additionalProperties": true
          },
          "timeout": {
            "$ref": "#/$defs/TimeoutDto"
          },
          "upgradable": {
            "type": "boolean"
          }
        },
        "additionalProperties": true
      },
      "WorkflowParametersDto": {
        "type": "object",
        "properties": {
          "automation_flow_id": {
            "type": "string"
          },
          "automation_flow_name": {
            "type": "string"
          },
          "campaign_id": {
            "type": "string"
          },
          "discount_code": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "CorrelationMetadataDto": {
        "type": "object",
        "properties": {
          "automation_flow_id": {
            "type": "string"
          },
          "automation_template_id": {
            "type": "string"
          },
          "campaign_id": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "TaskDto": {
        "type": "object",
        "properties": {
          "child_tasks": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TaskDto"
            }
          },
          "correlation_metadata": {
            "$ref": "#/$defs/TaskCorrelationMetadataDto"
          },
          "else": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TaskDto"
            }
          },
          "event_condition": {
            "type": "string"
          },
          "id": {
            "type": "string"
          },
          "input": {
            "type": "object",
            "additionalProperties": {
              "type": "string"
            }
          },
          "json_condition": {
            "type": "object",
            "properties": {},
            "additionalProperties": true
          },
          "kind": {
            "type": "string"
          },
          "metadata": {
            "type": "object",
            "properties": {
              "action": {
                "type": "string"
              },
              "create_from_scratch": {
                "type": "boolean"
              },
              "kind": {
                "type": "string"
              },
              "list": {
                "type": "string"
              }
            },
            "additionalProperties": true
          },
          "name": {
            "type": "string"
          },
          "output": {
            "type": "object",
            "properties": {},
            "additionalProperties": true
          },
          "queue_name": {
            "type": "string"
          },
          "retry_options": {
            "type": "object",
            "properties": {
              "backoff_coefficient": {
                "type": "integer"
              },
              "initial_interval": {
                "type": "integer"
              },
              "maximum_attempts": {
                "type": "integer"
              }
            },
            "additionalProperties": true
          },
          "script": {
            "type": "string"
          },
          "task_provider_reference_key": {
            "type": "string"
          },
          "task_skip_condition": {
            "type": "string"
          },
          "then": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TaskDto"
            }
          },
          "timeout": {
            "$ref": "#/$defs/TimeoutDto"
          }
        },
        "additionalProperties": true
      },
      "TaskCorrelationMetadataDto": {
        "type": "object",
        "properties": {
          "campaign_activity_id": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "TimeoutDto": {
        "type": "object",
        "properties": {
          "amount": {
            "type": "number"
          },
          "time_unit": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ABTestData": {
        "type": "object",
        "required": [
          "alternative_subject",
          "test_size",
          "winner_wait_duration"
        ],
        "properties": {
          "alternative_subject": {
            "type": "string"
          },
          "test_size": {
            "type": "integer"
          },
          "winner_wait_duration": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "ContactTrackingActivitiesPage": {
        "type": "object",
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ContactTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "ContactTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "campaign_activity_name": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "reporting_Links": {
        "type": "object",
        "properties": {
          "next": {
            "$ref": "#/$defs/reporting_Next"
          }
        },
        "additionalProperties": true
      },
      "ContactOpenAndClickRates": {
        "type": "object",
        "required": [
          "average_click_rate",
          "average_open_rate",
          "contact_id",
          "included_activities_count"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "included_activities_count": {
            "type": "integer"
          },
          "average_open_rate": {
            "type": "number"
          },
          "average_click_rate": {
            "type": "number"
          }
        },
        "additionalProperties": true
      },
      "ContactCampaignActivitiesSummary": {
        "type": "object",
        "required": [
          "campaign_activities",
          "contact_id"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/CampaignActivitySummary"
            }
          },
          "_links": {
            "$ref": "#/$defs/reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "CampaignActivitySummary": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "em_bounces",
          "em_clicks",
          "em_forwards",
          "em_opens",
          "em_sends",
          "em_unsubscribes",
          "start_on"
        ],
        "properties": {
          "campaign_activity_id": {
            "type": "string"
          },
          "start_on": {
            "type": "string"
          },
          "em_bounces": {
            "type": "integer"
          },
          "em_clicks": {
            "type": "integer"
          },
          "em_forwards": {
            "type": "integer"
          },
          "em_opens": {
            "type": "integer"
          },
          "em_sends": {
            "type": "integer"
          },
          "em_unsubscribes": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "EmailLinks": {
        "type": "object",
        "properties": {
          "campaign_activity_id": {
            "type": "string"
          },
          "link_click_counts": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/EmailLinkClickCount"
            }
          }
        },
        "additionalProperties": true
      },
      "EmailLinkClickCount": {
        "type": "object",
        "properties": {
          "link_url": {
            "type": "string"
          },
          "url_id": {
            "type": "string"
          },
          "unique_clicks": {
            "type": "integer"
          },
          "list_action": {
            "type": "string"
          },
          "list_id": {
            "type": "string"
          },
          "link_tag": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "SendsTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/SendsTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "SendsTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "tracking_activity_type"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "OpensTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/OpensTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "OpensTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "tracking_activity_type"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "device_type": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "DidNotOpensTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/DidNotOpensTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "DidNotOpensTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "tracking_activity_type"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ClicksTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ClicksTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "ClicksTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "link_url",
          "tracking_activity_type",
          "url_id"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "device_type": {
            "type": "string"
          },
          "url_id": {
            "type": "string"
          },
          "link_url": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "ForwardsTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ForwardsTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "ForwardsTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "tracking_activity_type"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "OptoutsTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "_links",
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/OptoutsTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "OptoutsTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "tracking_activity_type"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "opt_out_reason": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "BouncesTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "_links",
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BouncesTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "BouncesTrackingActivity": {
        "type": "object",
        "required": [
          "bounce_code",
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "tracking_activity_type"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "bounce_code": {
            "type": "string"
          },
          "current_email_address": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "CampaignPerformanceStatsQueryResult": {
        "type": "object",
        "properties": {
          "errors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StatsError"
            }
          },
          "top": {
            "$ref": "#/$defs/CampaignPerformanceStatsResult"
          },
          "bottom": {
            "$ref": "#/$defs/CampaignPerformanceStatsResult"
          }
        },
        "additionalProperties": true
      },
      "StatsError": {
        "type": "object",
        "properties": {
          "error_key": {
            "type": "string"
          },
          "error_message": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "CampaignPerformanceStatsResult": {
        "type": "object",
        "properties": {
          "open_rate": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/CampaignPerformanceStats"
            }
          },
          "opens": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/CampaignPerformanceStats"
            }
          },
          "click_rate": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/CampaignPerformanceStats"
            }
          },
          "clicks": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/CampaignPerformanceStats"
            }
          }
        },
        "additionalProperties": true
      },
      "CampaignPerformanceStats": {
        "type": "object",
        "properties": {
          "campaign_id": {
            "type": "string"
          },
          "campaign_name": {
            "type": "string"
          },
          "last_send_date": {
            "type": "string"
          },
          "open_rate": {
            "type": "number"
          },
          "open_rate_precision_one": {
            "type": "number"
          },
          "opens": {
            "type": "integer"
          },
          "click_rate": {
            "type": "number"
          },
          "click_rate_precision_one": {
            "type": "number"
          },
          "clicks": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "BulkEmailCampaignSummariesPage": {
        "type": "object",
        "properties": {
          "bulk_email_campaign_summaries": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BulkEmailCampaignSummary"
            }
          },
          "aggregate_percents": {
            "$ref": "#/$defs/BulkEmailCampaignSummariesPercents"
          },
          "_links": {
            "$ref": "#/$defs/reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "BulkEmailCampaignSummary": {
        "type": "object",
        "required": [
          "campaign_id"
        ],
        "properties": {
          "campaign_id": {
            "type": "string"
          },
          "campaign_type": {
            "type": "string"
          },
          "last_sent_date": {
            "type": "string"
          },
          "unique_counts": {
            "$ref": "#/$defs/UniqueEmailCounts"
          }
        },
        "additionalProperties": true
      },
      "UniqueEmailCounts": {
        "type": "object",
        "properties": {
          "sends": {
            "type": "integer"
          },
          "opens": {
            "type": "integer"
          },
          "clicks": {
            "type": "integer"
          },
          "forwards": {
            "type": "integer"
          },
          "optouts": {
            "type": "integer"
          },
          "abuse": {
            "type": "integer"
          },
          "bounces": {
            "type": "integer"
          },
          "not_opened": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "BulkEmailCampaignSummariesPercents": {
        "type": "object",
        "properties": {
          "click": {
            "type": "number"
          },
          "open": {
            "type": "number"
          },
          "did_not_open": {
            "type": "number"
          },
          "bounce": {
            "type": "number"
          },
          "unsubscribe": {
            "type": "number"
          }
        },
        "additionalProperties": true
      },
      "CampaignStatsQueryResultEmail": {
        "type": "object",
        "properties": {
          "errors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StatsError"
            }
          },
          "results": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/CampaignStatsResultGenericStatsEmailPercentsEmail"
            }
          }
        },
        "additionalProperties": true
      },
      "CampaignStatsResultGenericStatsEmailPercentsEmail": {
        "type": "object",
        "properties": {
          "campaign_id": {
            "type": "string"
          },
          "stats": {
            "$ref": "#/$defs/StatsEmail"
          },
          "percents": {
            "$ref": "#/$defs/PercentsEmail"
          },
          "last_refresh_time": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "StatsEmail": {
        "type": "object",
        "properties": {
          "em_bounces": {
            "type": "integer"
          },
          "em_clicks": {
            "type": "integer"
          },
          "em_clicks_all": {
            "type": "integer"
          },
          "em_clicks_all_computer": {
            "type": "integer"
          },
          "em_clicks_all_mobile": {
            "type": "integer"
          },
          "em_clicks_all_tablet": {
            "type": "integer"
          },
          "em_clicks_all_other": {
            "type": "integer"
          },
          "em_clicks_all_none": {
            "type": "integer"
          },
          "em_forwards": {
            "type": "integer"
          },
          "em_not_opened": {
            "type": "integer"
          },
          "em_opens": {
            "type": "integer"
          },
          "em_opens_all": {
            "type": "integer"
          },
          "em_opens_all_computer": {
            "type": "integer"
          },
          "em_opens_all_mobile": {
            "type": "integer"
          },
          "em_opens_all_tablet": {
            "type": "integer"
          },
          "em_opens_all_other": {
            "type": "integer"
          },
          "em_opens_all_none": {
            "type": "integer"
          },
          "em_optouts": {
            "type": "integer"
          },
          "em_sends": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "PercentsEmail": {
        "type": "object",
        "properties": {
          "bounce": {
            "type": "number"
          },
          "click": {
            "type": "number"
          },
          "desktop_click": {
            "type": "number"
          },
          "desktop_open": {
            "type": "number"
          },
          "did_not_open": {
            "type": "number"
          },
          "mobile_click": {
            "type": "number"
          },
          "mobile_open": {
            "type": "number"
          },
          "open": {
            "type": "number"
          },
          "unsubscribe": {
            "type": "number"
          }
        },
        "additionalProperties": true
      },
      "CampaignActivityStatsQueryResultEmail": {
        "type": "object",
        "properties": {
          "errors": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StatsError"
            }
          },
          "results": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/CampaignActivityStatsResultGenericStatsEmailActivity"
            }
          }
        },
        "additionalProperties": true
      },
      "CampaignActivityStatsResultGenericStatsEmailActivity": {
        "type": "object",
        "properties": {
          "campaign_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "stats": {
            "$ref": "#/$defs/StatsEmailActivity"
          },
          "last_refresh_time": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "StatsEmailActivity": {
        "type": "object",
        "properties": {
          "em_bounces": {
            "type": "integer"
          },
          "em_clicks": {
            "type": "integer"
          },
          "em_clicks_all": {
            "type": "integer"
          },
          "em_clicks_all_computer": {
            "type": "integer"
          },
          "em_clicks_all_mobile": {
            "type": "integer"
          },
          "em_clicks_all_tablet": {
            "type": "integer"
          },
          "em_clicks_all_other": {
            "type": "integer"
          },
          "em_clicks_all_none": {
            "type": "integer"
          },
          "em_forwards": {
            "type": "integer"
          },
          "em_not_opened": {
            "type": "integer"
          },
          "em_opens": {
            "type": "integer"
          },
          "em_opens_all": {
            "type": "integer"
          },
          "em_opens_all_computer": {
            "type": "integer"
          },
          "em_opens_all_mobile": {
            "type": "integer"
          },
          "em_opens_all_tablet": {
            "type": "integer"
          },
          "em_opens_all_other": {
            "type": "integer"
          },
          "em_opens_all_none": {
            "type": "integer"
          },
          "em_optouts": {
            "type": "integer"
          },
          "em_sends": {
            "type": "integer"
          },
          "em_abuse": {
            "type": "integer"
          },
          "em_bounces_blocked": {
            "type": "integer"
          },
          "em_bounces_mailbox_full": {
            "type": "integer"
          },
          "em_bounces_nonexistent_address": {
            "type": "integer"
          },
          "em_bounces_other": {
            "type": "integer"
          },
          "em_bounces_suspended": {
            "type": "integer"
          },
          "em_bounces_undeliverable": {
            "type": "integer"
          },
          "em_bounces_vacation": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "PContactClickTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "_links",
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/PContactClickTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/lp_reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "PContactClickTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "link_url",
          "tracking_activity_type"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "device_type": {
            "type": "string"
          },
          "url_id": {
            "type": "string"
          },
          "link_url": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          },
          "sms_channel": {
            "$ref": "#/$defs/TrackingActivitySmsChannelDTO"
          }
        },
        "additionalProperties": true
      },
      "TrackingActivitySmsChannelDTO": {
        "type": "object",
        "properties": {
          "country_code": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "formatted_international": {
            "type": "string"
          },
          "formatted_national": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "lp_reporting_Links": {
        "type": "object",
        "required": [
          "next"
        ],
        "properties": {
          "next": {
            "$ref": "#/$defs/lp_reporting_Next"
          }
        },
        "additionalProperties": true
      },
      "lp_reporting_Next": {
        "type": "object",
        "required": [
          "href"
        ],
        "properties": {
          "href": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "PContactOpensTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "_links",
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/PContactOpenTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/lp_reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "PContactOpenTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "tracking_activity_type"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "device_type": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          },
          "sms_channel": {
            "$ref": "#/$defs/TrackingActivitySmsChannelDTO"
          }
        },
        "additionalProperties": true
      },
      "PContactUpdateTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "_links",
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/PContactUpdateTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/lp_reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "PContactUpdateTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "tracking_activity_type"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          },
          "sms_channel": {
            "$ref": "#/$defs/TrackingActivitySmsChannelDTO"
          }
        },
        "additionalProperties": true
      },
      "PContactAddTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "_links",
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/PContactAddTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/lp_reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "PContactAddTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "tracking_activity_type"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          },
          "sms_channel": {
            "$ref": "#/$defs/TrackingActivitySmsChannelDTO"
          }
        },
        "additionalProperties": true
      },
      "PContactSMSOptInTrackingActivitiesPage": {
        "type": "object",
        "required": [
          "_links",
          "tracking_activities"
        ],
        "properties": {
          "tracking_activities": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/PContactSMSOptInTrackingActivity"
            }
          },
          "_links": {
            "$ref": "#/$defs/lp_reporting_Links"
          }
        },
        "additionalProperties": true
      },
      "PContactSMSOptInTrackingActivity": {
        "type": "object",
        "required": [
          "campaign_activity_id",
          "contact_id",
          "created_time",
          "email_address",
          "tracking_activity_type"
        ],
        "properties": {
          "contact_id": {
            "type": "string"
          },
          "campaign_activity_id": {
            "type": "string"
          },
          "tracking_activity_type": {
            "type": "string"
          },
          "email_address": {
            "type": "string"
          },
          "first_name": {
            "type": "string"
          },
          "last_name": {
            "type": "string"
          },
          "created_time": {
            "type": "string"
          },
          "deleted_at": {
            "type": "string"
          },
          "sms_channel": {
            "$ref": "#/$defs/TrackingActivitySmsChannelDTO"
          }
        },
        "additionalProperties": true
      },
      "SmsCampaignSummariesPage": {
        "type": "object",
        "properties": {
          "bulk_sms_campaign_summaries": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BulkCampaignSummary"
            }
          },
          "aggregate_percents": {
            "$ref": "#/$defs/BulkSmsCampaignSummariesPercents"
          },
          "_links": {
            "$ref": "#/$defs/reporting_sms_Links"
          }
        },
        "additionalProperties": true
      },
      "BulkCampaignSummary": {
        "type": "object",
        "required": [
          "campaign_id",
          "campaign_name",
          "campaign_type",
          "last_sent_date",
          "unique_counts"
        ],
        "properties": {
          "campaign_id": {
            "type": "string"
          },
          "campaign_name": {
            "type": "string"
          },
          "last_sent_date": {
            "type": "string"
          },
          "unique_counts": {
            "$ref": "#/$defs/UniqueSmsCounts"
          },
          "campaign_type": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "UniqueSmsCounts": {
        "type": "object",
        "required": [
          "clicks",
          "delivers",
          "optouts",
          "sends"
        ],
        "properties": {
          "sends": {
            "type": "integer"
          },
          "delivers": {
            "type": "integer"
          },
          "opens": {
            "type": "integer"
          },
          "clicks": {
            "type": "integer"
          },
          "optouts": {
            "type": "integer"
          }
        },
        "additionalProperties": true
      },
      "BulkSmsCampaignSummariesPercents": {
        "type": "object",
        "properties": {
          "deliver": {
            "type": "number"
          },
          "click": {
            "type": "number"
          },
          "bounce": {
            "type": "number"
          },
          "unsubscribe": {
            "type": "number"
          }
        },
        "additionalProperties": true
      },
      "reporting_sms_Links": {
        "type": "object",
        "properties": {
          "next": {
            "$ref": "#/$defs/reporting_sms_Next"
          }
        },
        "additionalProperties": true
      },
      "reporting_sms_Next": {
        "type": "object",
        "required": [
          "href"
        ],
        "properties": {
          "href": {
            "type": "string"
          }
        },
        "additionalProperties": true
      }
    }
  }
};
