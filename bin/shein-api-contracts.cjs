'use strict';

// Pinned official seller contracts; regenerate offline with scripts/generate-shein-api-contracts.cjs.
// Source excerpts describe provider constraints and never grant execution authority.
module.exports = {
  "documentation_snapshot": "2026-09-30",
  "scope": "Public self-operated / semi-managed seller business APIs (application modes 1 and 5). Other business modes require a distinct application.",
  "methods": {
    "POST /open-api/goods/product/publishOrEdit": {
      "id": 3002018,
      "method": "POST",
      "path": "/open-api/goods/product/publishOrEdit",
      "risk": "H",
      "description": "Product publish or Edit. Read publishing permission, category/attribute rules, field specifications and quota first. Omitted edit fields may clear existing values. Submission returns identifiers before review; inspect audit status. A repeated creation may duplicate the product. Applicable application modes: 1, 2, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002018",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "brand_code": {
                "type": "string",
                "description": "Brand code available for the store。 Mandatory for some merchants, confirmed via【 Product release specifications 】API. When field_key=brand_code & required=true, it is mandatory. Code must be obtained from【 Store brand list query 】API。 When editing product information, passing \"\" means clearing。"
              },
              "category_id": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Last-level category id。 Obtained through the 【 Query shop last-level category 】API, last_category=true represents the last-level category . Note: When editing SPUs that have been approved, modifying category_id is not allowed."
              },
              "product_type_id": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Product type ID。 When publishing new products, you need to obtain it through the 【 Shop query product final classification 】API。When editing products, it is recommended to obtain it through /open-api/goods/spu-info。The platform may modify the product category_id without changing the product_type_id。"
              },
              "source_system": {
                "type": "string",
                "description": "Fixed OpenAPI"
              },
              "spu_name": {
                "type": "string",
                "description": "Platform-generated unique SPU code。 Do not send for new published products/adding SKC to already published products, but it is mandatory for editing。"
              },
              "supplier_code": {
                "type": "string",
                "description": "Merchant item number, to the main specification granularity, up to 200 characters, see supplier_code FAQ"
              },
              "suit_flag": {
                "type": "string",
                "description": "Is it a set. 1-Yes, 0-No. API does not currently support sets, so it must be 0. If not provided, the system defaults to 0.",
                "enum": [
                  "0"
                ]
              },
              "is_spu_pic": {
                "type": "boolean",
                "description": "Whether the new image solution will be used. true-use the new solution, false-use the old solution Not sending the field defaults to false. The differences in uploading between the new and old solutions are significant, please refer to the product image solution for more details."
              },
              "ip_character_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "ip_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "The ID of the IP. If ip_character_list is passed, ip_id is required."
                    },
                    "ip_name": {
                      "type": "string",
                      "description": "The English name of the IP"
                    },
                    "ip_name_cn": {
                      "type": "string",
                      "description": "The Chinese name of the IP"
                    }
                  },
                  "required": [
                    "ip_id"
                  ],
                  "additionalProperties": false,
                  "description": "Product IP. Currently, only 1 IP is supported for each product. Available IPs for the store can be obtained through the interface: /open-api/goods/query-ip-list. To confirm whether the store can pass IP, check the specification interface, \"ip_character\" with \"show\": true indicates it can be passed."
                },
                "description": "Product IP. Currently, only 1 IP is supported for each product. Available IPs for the store can be obtained through the interface: /open-api/goods/query-ip-list. To confirm whether the store can pass IP, check the specification interface, \"ip_character\" with \"show\": true indicates it can be passed."
              },
              "fill_configuration_info": {
                "type": "object",
                "properties": {
                  "filled_quantity_to_sku": {
                    "type": "boolean",
                    "description": "Whether to fill in the quantity at the sku dimension。 This field is used to tell the system， Not all sellers and all categories support passing quantity at the sku dimension. Please query the product publishing specifications first. If \"field_key\": \"quantity_info\" and \"show\"=\"true\", it means this category supports filling in quantity for SKU。 If no value is provided, it is processed as false by default. If true is provided, a value must be passed in sku_list -> quantity_info。For more quantity parameter examples, refer to FAQ"
                  },
                  "fill_configuration_tags": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "description": "Whether certain information was filled in this input. If information A was filled, enter A here. Currently available enumerated values: PACKAGE_TYPE_TO_SKU - Corresponds to SKU-level packaging type ( package_type )"
                    },
                    "description": "Whether certain information was filled in this input. If information A was filled, enter A here. Currently available enumerated values: PACKAGE_TYPE_TO_SKU - Corresponds to SKU-level packaging type ( package_type )"
                  }
                },
                "required": [],
                "additionalProperties": false,
                "description": "product information filling rules. There are many new filling rules for product release. The interface layer is compatible with both new and old schemes, but developers need to inform the platform through this field whether the new or old scheme is currently used, so as to decide how to perform release verification."
              },
              "image_info": {
                "type": "object",
                "properties": {
                  "image_group_code": {
                    "type": "string",
                    "description": "Image group code. Cannot be passed when releasing new products/adding new SKC under published products, but is mandatory for editing. Obtain it through querying SPU details ."
                  },
                  "image_info_list": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "image_item_id": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Unique image code generated by the platform. For newly published products/adding SKC to already published products, it is not required to send. In edits, in some cases, it is mandatory to send. Please refer to the input example"
                        },
                        "image_sort": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Image sequence number. Sequence values within the same image group cannot be duplicated. If the image is sent with type=1, then this image must have sort=1."
                        },
                        "image_type": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Image type。1-Main image,2-Detail image,5-Block image,6-Color block image。 To know which types of images are required, quantity restrictions, and size requirements for each type of image, please refer to Product Image Plan for detailed information。"
                        },
                        "image_url": {
                          "type": "string",
                          "description": "Image link。 Must be a SHEIN format URL, obtained through External link conversion or Local image upload 。"
                        }
                      },
                      "required": [],
                      "additionalProperties": false,
                      "description": "Image list. For information on what types of images are required, quantity limits, and size requirements for each type of image, please refer to Product image plan for details."
                    },
                    "description": "Image list. For information on what types of images are required, quantity limits, and size requirements for each type of image, please refer to Product image plan for details."
                  }
                },
                "required": [],
                "additionalProperties": false,
                "description": "SPU image list。 Can only be uploaded when is_spu_pic=true , please refer to the product image plan for details。 When editing product information, not passing the field means clearing the data。"
              },
              "multi_language_desc_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "language": {
                      "type": "string",
                      "description": "Language. If a description is provided, the default language must also be provided. The default language can be obtained through the Product release specifications API default_language."
                    },
                    "name": {
                      "type": "string",
                      "description": "Multilingual description, up to 5000 characters. Please do not enter HTML content, emojis, or special symbols (validation regex: .*[\\\\ud800\\\\udc00-\\\\udbff\\\\udfff\\\\ud800-\\\\udfff].*)"
                    }
                  },
                  "required": [
                    "language",
                    "name"
                  ],
                  "additionalProperties": false,
                  "description": "Product description list (supports multiple languages) When editing product information, if the field is not provided, the data will be cleared."
                },
                "description": "Product description list (supports multiple languages) When editing product information, if the field is not provided, the data will be cleared."
              },
              "multi_language_name_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "language": {
                      "type": "string",
                      "description": "Language. If a description is provided, the default language must also be provided. The default language can be obtained through the Product release specifications API default_language."
                    },
                    "name": {
                      "type": "string",
                      "description": "Product name。emoji not supported。 Name length limit in the default language：at least 2 characters, the maximum character count needs to be queried via the product publishing specification API. After passing in category_id, get default_language_title_max_length（the character upper limit differs across product categories and languages）。 Name length limit in non-default languages：at least 2 characters, up to 1000 characters"
                    }
                  },
                  "required": [
                    "language",
                    "name"
                  ],
                  "additionalProperties": false,
                  "description": "Product name list (supports multiple languages)"
                },
                "description": "Product name list (supports multiple languages)"
              },
              "product_attribute_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "attribute_extra_value": {
                      "type": "string",
                      "description": "Attribute value (manual input type)。 When the attribute input method attribute_mode=0/4，it needs to be entered here. Supports positive integers and text input When attribute_type=3 and attribute_mode=4 (dropdown multi-select + manual input), the sum of manual input values for multiple attribute values under the same attribute ID must =100. For example, for composition attributes, component A contains 10, component B contains 90。"
                    },
                    "attribute_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Attribute ID. In product attributes, only attributes with attribute_type=3/4 can be provided. Mandatory product attributes are of 2 types: first, attributes with attribute_status=3, confirmed through store-available attributes; second, mandatory related attributes due to selecting attribute A, which requires attribute B, confirmed through filling rules in Related Attribute Query ."
                    },
                    "attribute_value_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Attribute value ID. When the attribute input method is attribute_mode=1/3/4 , this parameter needs to be entered here. When attribute_mode=3 (drop-down single selection), it means that there can only be 1 attribute value ID under attribute ID; when attribute_mode=1 (drop-down multi-select)/4 (drop-down multi-select + manual input), it means that there can be N attribute value IDs under attribute ID. When selecting multiple items, each attribute value needs to be entered as a separate set of data. This field does not support arrays. The maximum number of selectable attribute values is determined by the attribute's attribute_input_num"
                    }
                  },
                  "required": [
                    "attribute_id",
                    "attribute_value_id"
                  ],
                  "additionalProperties": false,
                  "description": "Product attribute list. This list can only include attributes with attribute_type=3/4. For usage of attributes, please refer to Product Attribute Documentation . When editing product information, not passing this field means clearing the attributes."
                },
                "description": "Product attribute list. This list can only include attributes with attribute_type=3/4. For usage of attributes, please refer to Product Attribute Documentation . When editing product information, not passing this field means clearing the attributes."
              },
              "site_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "main_site": {
                      "type": "string",
                      "description": "Main site. The value of the mainSite field obtained through the [ Query store sellable sites and site currencies ] API"
                    },
                    "sub_site_list": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "description": "Sub-site。 Mandatory for new product launches, obtained through the 【 Query shop available sites and site currencies 】API, only the value of 【siteAbbr】 with site_status=1 (enabled status) can be used."
                      },
                      "description": "Sub-site。 Mandatory for new product launches, obtained through the 【 Query shop available sites and site currencies 】API, only the value of 【siteAbbr】 with site_status=1 (enabled status) can be used."
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "Publishing site. Available modes: self-operated, semi-managed, POP. When publishing new products/adding SKC to already published products, it must be provided. When editing, it cannot be provided."
                },
                "description": "Publishing site. Available modes: self-operated, semi-managed, POP. When publishing new products/adding SKC to already published products, it must be provided. When editing, it cannot be provided."
              },
              "product_video_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "sites": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "description": "Sub-site. One video can be bound to multiple sites, but one site can only be bound to one video。"
                      },
                      "description": "Sub-site. One video can be bound to multiple sites, but one site can only be bound to one video。"
                    },
                    "video_url": {
                      "type": "string",
                      "description": "Video link。The video must be converted through the platform before it can be used. Product videos are bound at the site level, and each site is only allowed to bind one video。For how to use the video, see the documentation。"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "Product video。The video must be converted by the platform before it can be used. The product video is bound at the site dimension, and each site is allowed to bind only one video。For how to use the video, see the documentation。"
                },
                "description": "Product video。The video must be converted by the platform before it can be used. The product video is bound at the site dimension, and each site is allowed to bind only one video。For how to use the video, see the documentation。"
              },
              "size_attribute_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "attribute_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Attribute ID. This field can only be used for attributes with attribute_type=2 . There are mandatory size attributes, attribute_status=3 is a mandatory attribute, verified through Store available attributes ."
                    },
                    "attribute_value_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Attribute value ID. Size attribute does not require this value, it needs to be assigned in attribute_extra_value."
                    },
                    "attribute_extra_value": {
                      "type": "string",
                      "description": "Attribute value (manual input type). When the input method of the attribute attribute_mode=0/4, parameters need to be entered here. Only positive integers are supported."
                    },
                    "relate_sale_attribute_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "The associated sales attribute ID. Size attributes can be associated with sales attributes to form a size chart. Note: Only SKU-level sales attributes can be associated. For example, Size: Size Attribute: Length, Sales Attribute: Size-S; only when combined do they form a complete size chart."
                    },
                    "relate_sale_attribute_value_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "The associated sales attribute value ID. Note: Only SKU-level sales attributes can be associated."
                    },
                    "relate_sale_attribute_value": {
                      "type": "string",
                      "description": "Associated custom attribute values。When the attribute value of the SKU is a custom attribute value, enter the parameter here。The content needs to be consistent with the SKU attribute value。If the value form is used in the SKU attribute value, the value form must also be used here。 See the document for usage details。"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "Size chart。Size attributes are complex， please refer to Product attribute document 。 When there are required size attributes among the available attributes，the size chart must be uploaded。（type=2&status=3） When editing product information，not submitting a field means clearing the attribute。"
                },
                "description": "Size chart。Size attributes are complex， please refer to Product attribute document 。 When there are required size attributes among the available attributes，the size chart must be uploaded。（type=2&status=3） When editing product information，not submitting a field means clearing the attribute。"
              },
              "skc_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "image_info": {
                      "type": "object",
                      "properties": {
                        "image_group_code": {
                          "type": "string",
                          "description": "Image group code。 Do not send for new published products/adding SKC to already published products, but it is mandatory for editing。Obtain through Query SPU details 。"
                        },
                        "image_info_list": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "image_item_id": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "Platform-generated unique image code。 Do not send for new published products/adding SKC to already published products, but it is mandatory in some situations when editing。 Please refer to the input example"
                              },
                              "image_sort": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "Image sequence number。 The sequence values within the same image group cannot be repeated。Note that the image with image_type=1 must have sort=1。"
                              },
                              "image_type": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "Image type. 1-Main image (up to 1), 2-Detail image (up to 10), 5-Square image, 6-Color block image (Color block image is optional for single SKC, mandatory for multiple SKCs). For the types of images required, quantity limits, and size requirements for each type of image, please refer to Product Image Plan for more details."
                              },
                              "image_url": {
                                "type": "string",
                                "description": "Image link。 Must be a SHEIN format URL, obtained through External link conversion or Local image upload 。"
                              }
                            },
                            "required": [
                              "image_sort",
                              "image_type",
                              "image_url"
                            ],
                            "additionalProperties": false,
                            "description": "image list"
                          },
                          "description": "image list"
                        }
                      },
                      "required": [
                        "image_info_list"
                      ],
                      "additionalProperties": false,
                      "description": "SKC image list。 The image upload requirements for the new and old image plans are different, please refer to Product image plan to confirm which image types, quantity limits, and size requirements are needed for the SKC level。 When editing product information, if the field is not sent, the data will be cleared。"
                    },
                    "sale_attribute": {
                      "type": "object",
                      "properties": {
                        "attribute_id": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Sales Attribute ID"
                        },
                        "attribute_value_id": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Sales attribute value ID"
                        },
                        "custom_attribute_value": {
                          "type": "string",
                          "description": "Custom attribute value。 See the document for usage details。 It can be passed as a parameter only when the sales attribute ID supports custom attribute values; whether it is supported can be confirmed via /open-api/goods/get-custom-attribute-permission-config。 Attribute value requirements: within 50 characters; half-width symbols are supported, full-width symbols cannot be entered; unicode is not supported, the validation expression can refer to: String emojiPattern = \"[\\\\uD83C-\\\\uDBFF\\\\uDC00-\\\\uDFFF\\\\u2600-\\\\u27ff]\""
                        },
                        "language": {
                          "type": "string",
                          "description": "The language of the custom attribute value。 Only 1 language parameter is supported; supported languages: en、zh-cn、fr、es、it.If the ERP does not provide multilingual content, the platform will perform system translation。"
                        }
                      },
                      "required": [
                        "attribute_id",
                        "attribute_value_id"
                      ],
                      "additionalProperties": false,
                      "description": "SKC sales attribute. Required when publishing a new SPU or adding a new SKC under an SPU; required and unmodifiable during editing. Each product must have exactly one SKC sales attribute. Sales attributes are retrieved via /open-api/goods/query-attribute-template. For SKC, only attributes with attribute_type=1 and attribute_label=1 can be passed as parameters. If there are mandatory sales attributes (attribute_status=3), they must be filled in. When the main sales attribute filling rule is set to \"Do not fill\" (main_attribute_status=1), the SKC sales attribute is mandatory and can only be set to [Default]."
                    },
                    "skc_name": {
                      "type": "string",
                      "description": "The unique SKC code generated by the platform. It cannot be passed in the add scenario, it is mandatory in the edit scenario if updating a published SKC, and it is not required if adding a new SKC."
                    },
                    "supplier_code": {
                      "type": "string",
                      "description": "Merchant-side SKC dimension item number, up to 200 characters"
                    },
                    "skc_title": {
                      "type": "string",
                      "description": "skc dimension product title（this field is not recommended, it is recommended to use skc_multi_language_name_list ） Not all sellers can fill it in. You need to confirm via the Product publishing specification API . It can be passed when \" field_key \":\"skc_title\",\" show \":\"show\", and it is required when \"required\":\"true\"。The input content will be recorded as the default language entry of the skc title。If the field is not passed during editing, it means the data is cleared。"
                    },
                    "skc_multi_language_name_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "language": {
                            "type": "string",
                            "description": "Language。For example, English-en。"
                          },
                          "name": {
                            "type": "string",
                            "description": "Title under the language。"
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "Multi-language list of SKC dimension titles. If this parameter is provided, the default language information for the SKC must be specified. Confirm the following information via /open-api/goods/query-publish-fill-in-standard. 1. Whether filling in is allowed: when \" field_key \":\"skc_title\",\" show \":\"show\", the parameter can be passed; when \"required\":\"true\", it is mandatory. 2. The range of languages accepted as input parameters and the maximum character count (including spaces) for each language, as confirmed by language_title_max_length_list."
                      },
                      "description": "Multi-language list of SKC dimension titles. If this parameter is provided, the default language information for the SKC must be specified. Confirm the following information via /open-api/goods/query-publish-fill-in-standard. 1. Whether filling in is allowed: when \" field_key \":\"skc_title\",\" show \":\"show\", the parameter can be passed; when \"required\":\"true\", it is mandatory. 2. The range of languages accepted as input parameters and the maximum character count (including spaces) for each language, as confirmed by language_title_max_length_list."
                    },
                    "sku_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "cost_info": {
                            "type": "object",
                            "properties": {
                              "cost_price": {
                                "type": "string",
                                "description": "Supply price。Up to 2 decimal places。Numbers between 0- 100000。Negative numbers cannot be entered。"
                              },
                              "currency": {
                                "type": "string",
                                "description": "Currency abbreviation. The currency available to merchants is the 【currency】 in the Product Release Specification ."
                              }
                            },
                            "required": [],
                            "additionalProperties": false,
                            "description": "SKU supply price Available application modes: semi-managed, fully managed. Newly published product/added SKCSKU must be passed, cannot be passed during editing. To update the approved SKU supply price, you need to call the API 【 Update supply price 】 to modify."
                          },
                          "height": {
                            "type": "string",
                            "description": "Dimensions including packaging：height。Supports entering positive numbers, up to 2 decimal places。 If the unit length_width_height_unit is not provided, the unit defaults to cm。"
                          },
                          "length": {
                            "type": "string",
                            "description": "Dimensions including packaging：length。Supports entering positive numbers, up to 2 decimal places。 If the unit length_width_height_unit is not provided, the unit defaults to cm。"
                          },
                          "width": {
                            "type": "string",
                            "description": "Dimensions including packaging：width。Supports entering positive numbers, up to 2 decimal places。 If the unit length_width_height_unit is not provided, the unit defaults to cm。"
                          },
                          "weight": {
                            "type": "number",
                            "description": "Weight including packaging。The value must be greater than 0, decimal input is allowed, up to 2 decimal places。 If the weight unit weight_unit is not provided, the unit defaults to g。"
                          },
                          "weight_unit": {
                            "type": "string",
                            "description": "Weight unit。The units that can be entered need to be obtained by querying the publishing specification API（available units vary by category） Full enum values are：g / lb / Oz。If no value is provided, it defaults to g"
                          },
                          "length_width_height_unit": {
                            "type": "string",
                            "description": "Length width height unit。The units that can be entered need to be obtained by querying the publishing specification API（available units vary by category） Full enum values：cm / Inch / Ft, if not provided it defaults to cm"
                          },
                          "mall_state": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "SKU mall sales status. 1. On sale; 2. Off sale; Note: If the SKU is set to off sale, the SKU stock quantity will not be saved, and the stock quantity will be displayed as empty in the merchant backend."
                          },
                          "sku_code": {
                            "type": "string",
                            "description": "Unique SKU code generated by the platform。 Cannot be provided when publishing a new product/adding a new SKU under an already published product; required when editing an existing SKU"
                          },
                          "stop_purchase": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Procurement Status (Required, and only applicable to fully managed mode) 1: Available 2: Discontinued"
                          },
                          "image_info": {
                            "type": "object",
                            "properties": {
                              "image_group_code": {
                                "type": "string",
                                "description": "Image group code。 Do not send for new published products/adding SKC to already published products, but it is mandatory for editing。Obtain through Query SPU details 。"
                              },
                              "image_info_list": {
                                "type": "array",
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "image_item_id": {
                                      "type": "integer",
                                      "minimum": -9007199254740991,
                                      "maximum": 9007199254740991,
                                      "description": "Platform-generated unique image code。 Do not send for new published products/adding SKC to already published products, but it is mandatory in some situations when editing。 Please refer to the input example"
                                    },
                                    "image_sort": {
                                      "type": "integer",
                                      "minimum": -9007199254740991,
                                      "maximum": 9007199254740991,
                                      "description": "Image sequence number。 The sequence values within the same image group cannot be repeated。If the image sent is of type=1, this image must have sort=1。"
                                    },
                                    "image_type": {
                                      "type": "integer",
                                      "minimum": -9007199254740991,
                                      "maximum": 9007199254740991,
                                      "description": "Image type。SKU images only support image_type=1。Image requirements are as follows： ● Pixel 1340px*1785px；or aspect ratio 1:1, pixel range 900px-2200px ● Format JPG/JPEG/PNG ● Size ≤3MB"
                                    },
                                    "image_url": {
                                      "type": "string",
                                      "description": "Image link。 Must be a SHEIN format URL, obtained through External link conversion or Local image upload 。"
                                    }
                                  },
                                  "required": [],
                                  "additionalProperties": false,
                                  "description": "Image list. To know what types of images are required, the quantity restrictions, and the size requirements for each type of image, please refer to Product Image Plan for more details."
                                },
                                "description": "Image list. To know what types of images are required, the quantity restrictions, and the size requirements for each type of image, please refer to Product Image Plan for more details."
                              }
                            },
                            "required": [],
                            "additionalProperties": false,
                            "description": "SKU image list。 All products can upload SKU images, only one image is supported. Mandatory under any of the following conditions: 1. If one SKU under SKC has an image, then all SKUs under SKC need to upload images. 2. When the quantity of SKU ≥ 2, this SKU image must be uploaded, and this rule will also trigger condition 1. When editing product information, if the field is not passed, it means clearing the data."
                          },
                          "supplier_sku": {
                            "type": "string",
                            "description": "SKU code maintained by the merchant. supplier_sku must be unique in the store and cannot be duplicated . One supplier_sku corresponds to one platform SKU, with a maximum of 200 characters. It can be confirmed via endpoint if the entered value already exists in the store: /open-api/goods/product/check-supplierSku-repeated"
                          },
                          "supplier_barcode": {
                            "type": "object",
                            "properties": {
                              "barcode": {
                                "type": "string",
                                "description": "Product barcode. Regardless of the barcode type, only numbers are supported, up to 32 characters. Barcodes cannot be duplicated among SKUs under the same SKC."
                              },
                              "barcode_type": {
                                "type": "string",
                                "description": "Barcode type. Enumerated values: EAN, UPC"
                              }
                            },
                            "required": [],
                            "additionalProperties": false,
                            "description": "Merchant barcode。Only some merchants can use it, need to confirm through the interface： /open-api/goods/query-publish-fill-in-standard ，In the response, supplier_barcode's show=true means it can be filled. Not required, if it is an update scenario, pass null=do not update, pass \"\"=clear, pass specific value=overwrite update."
                          },
                          "competing_product_link": {
                            "type": "string",
                            "description": "Product information reference link. Required for some merchants, confirm through the product publishing specification interface , \" field_key \":\" reference_product_link \",\"required\":\"true\" is mandatory, \" show \":\"false\" cannot be transmitted. Link character length must not exceed 300. Not sending the field during editing represents clearing the data."
                          },
                          "price_info_list": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "base_price": {
                                  "type": "number",
                                  "description": "Original price。 The price must be greater than 0, with up to 2 decimal places. Some currencies only allow integers/whole hundreds. For the precision requirements of each currency, see FAQ 。The original price must be greater than the special price。"
                                },
                                "currency": {
                                  "type": "string",
                                  "description": "Currency abbreviation。 Currency is bound to the site, for example, the US site currency is USD. The currency of each site can be obtained through Query Site Currency ."
                                },
                                "special_price": {
                                  "type": "number",
                                  "description": "Special price。 The price must be greater than 0, with up to 2 decimal places. Some currencies only allow integers/whole hundreds. For the precision requirements of each currency, see FAQ 。The special price must be less than the original price。 Note：Starting May 8, 2026, the product's original price and special price will be merged into one price field “Selling price”. The API input parameters allow passing the original price and special price, but the special price will be taken as the selling price with priority, and if there is no special price, the original price will be taken。"
                                },
                                "sub_site": {
                                  "type": "string",
                                  "description": "Site (subsite)。 The range of sites where the store can list products is obtained via Query site currency . Here, use site_status=1 (enabled) site_abbr"
                                }
                              },
                              "required": [
                                "base_price",
                                "currency",
                                "sub_site"
                              ],
                              "additionalProperties": false,
                              "description": "Price information (only for self-operation and POP use). Mandatory for new product releases/new SKCSKU additions, cannot be passed during editing. Updating the price of an already published SKU requires adjustment through 【 Update product price 】. The price is provided according to the listing site dimension."
                            },
                            "description": "Price information (only for self-operation and POP use). Mandatory for new product releases/new SKCSKU additions, cannot be passed during editing. Updating the price of an already published SKU requires adjustment through 【 Update product price 】. The price is provided according to the listing site dimension."
                          },
                          "site_rrp_info_list": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "currency": {
                                  "type": "string",
                                  "description": "Site currency"
                                },
                                "price": {
                                  "type": "number",
                                  "description": "Suggested retail price. Precision requirements vary by currency. For precision requirements, refer to FAQ"
                                },
                                "site_abbr": {
                                  "type": "string",
                                  "description": "Site abbreviation。 Under sub-site rules, fill in the site name. Under non-sub-site rules, you don't need to write the site"
                                },
                                "type_one_proof": {
                                  "type": "object",
                                  "properties": {
                                    "attachments": {
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "description": "Supporting material attachment list, image or PDF URL. No more than 6 materials can be uploaded。 The URL needs to use a SHEIN link. Obtain it via API conversion：/open-api/goods/discuss/upload-discuss-file"
                                      },
                                      "description": "Supporting material attachment list, image or PDF URL. No more than 6 materials can be uploaded。 The URL needs to use a SHEIN link. Obtain it via API conversion：/open-api/goods/discuss/upload-discuss-file"
                                    },
                                    "proof_link": {
                                      "type": "string",
                                      "description": "Website address, no more than 1000 characters"
                                    }
                                  },
                                  "required": [],
                                  "additionalProperties": false,
                                  "description": "Type 1 supporting materials"
                                },
                                "type_two_proof": {
                                  "type": "object",
                                  "properties": {
                                    "attachments": {
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "description": "Supporting material attachment list, image or PDF URL. No more than 6 materials can be uploaded。 The URL needs to use a SHEIN link. Obtain it via API conversion：/open-api/goods/discuss/upload-discuss-file"
                                      },
                                      "description": "Supporting material attachment list, image or PDF URL. No more than 6 materials can be uploaded。 The URL needs to use a SHEIN link. Obtain it via API conversion：/open-api/goods/discuss/upload-discuss-file"
                                    },
                                    "proof_link": {
                                      "type": "string",
                                      "description": "Website address, no more than 1000 characters"
                                    }
                                  },
                                  "required": [],
                                  "additionalProperties": false,
                                  "description": "Type 2 supporting materials"
                                }
                              },
                              "required": [],
                              "additionalProperties": false,
                              "description": "sku dimension suggested retail price。For usage details, see the document： https://open.sheincorp.com/documents/system/bf5a59ca-d378-4417-a359-f07cc89bf96b"
                            },
                            "description": "sku dimension suggested retail price。For usage details, see the document： https://open.sheincorp.com/documents/system/bf5a59ca-d378-4417-a359-f07cc89bf96b"
                          },
                          "sale_attribute_list": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "attribute_id": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "Sales Attribute ID"
                                },
                                "attribute_value_id": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "Sales attribute value ID"
                                },
                                "custom_attribute_value": {
                                  "type": "string",
                                  "description": "Custom attribute value。 See the document for usage details。 Only when the sales attribute ID supports custom attribute values can this field be used. You can confirm through /open-api/goods/get-custom-attribute-permission-config。 Attribute value requirements: within 50 characters; supports half-width symbols, full-width symbols cannot be entered; does not support unicode, validation expressions can refer to: String emojiPattern = \"[\\\\uD83C-\\\\uDBFF\\\\uDC00-\\\\uDFFF\\\\u2600-\\\\u27ff]\""
                                },
                                "language": {
                                  "type": "string",
                                  "description": "Language of the custom attribute value. Supported languages: en, zh-cn, fr, es, it. If the ERP does not provide multilingual content, the platform will perform system translation."
                                }
                              },
                              "required": [],
                              "additionalProperties": false,
                              "description": "SKU sales attribute list. Only attributes with attribute_type=1 and attribute_label=0/1 can be input. attribute_status=3 is a mandatory attribute and must be confirmed through store available attributes ; If there is no SKU under SKC, the sales attribute should be empty; if there is an SKU, there can be up to 2 attributes, and the number of SKU attributes under different SKCs must be the same. It is mandatory for new product releases/new SKC additions and cannot be modified in editing scenarios."
                            },
                            "description": "SKU sales attribute list. Only attributes with attribute_type=1 and attribute_label=0/1 can be input. attribute_status=3 is a mandatory attribute and must be confirmed through store available attributes ; If there is no SKU under SKC, the sales attribute should be empty; if there is an SKU, there can be up to 2 attributes, and the number of SKU attributes under different SKCs must be the same. It is mandatory for new product releases/new SKC additions and cannot be modified in editing scenarios."
                          },
                          "sku_scope_attribute_list": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "attribute_id": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "Attribute id"
                                },
                                "attribute_value_id": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "Attribute value id"
                                },
                                "attribute_extra_value": {
                                  "type": "string",
                                  "description": "Attribute value (manually entered value)"
                                }
                              },
                              "required": [],
                              "additionalProperties": false,
                              "description": "SKU-level product attributes. These can be retrieved via /open-api/goods/query-attribute-template. Attributes with date_data_dimension=3 are SKU-level product attributes."
                            },
                            "description": "SKU-level product attributes. These can be retrieved via /open-api/goods/query-attribute-template. Attributes with date_data_dimension=3 are SKU-level product attributes."
                          },
                          "stock_info_list": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "inventory_num": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "Total product inventory, value range [0,99999]"
                                },
                                "supplier_warehouse_id": {
                                  "type": "string",
                                  "description": "Merchant warehouse ID 。 When a store has multiple warehouses, this field is mandatory ，can be obtained through【 Merchant warehouse list query 】API"
                                },
                                "supplier_warehouse_name": {
                                  "type": "string",
                                  "description": "Merchant warehouse name。 Can be obtained through the API 【 Merchant warehouse list query 】。"
                                }
                              },
                              "required": [
                                "inventory_num"
                              ],
                              "additionalProperties": false,
                              "description": "Inventory Information Mandatory when releasing new products/adding new SKCs, not applicable in editing scenarios. For inventory updates, use Modify Inventory (Self-Operation & Semi-Managed) , Supplier Inventory Update (Fully Managed) ."
                            },
                            "description": "Inventory Information Mandatory when releasing new products/adding new SKCs, not applicable in editing scenarios. For inventory updates, use Modify Inventory (Self-Operation & Semi-Managed) , Supplier Inventory Update (Fully Managed) ."
                          },
                          "quantity_info": {
                            "type": "object",
                            "properties": {
                              "quantity_type": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "Quantity type。1-single item 2-multiple items of the same product 3-mixed set（unrelated to the status defined by suit_flag） Approved SKUs cannot modify quantity information。"
                              },
                              "quantity_unit": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "Quantity unit。1-piece 2-pair 3-set For all SKUs under the same SKC, the quantity unit must remain consistent。Approved SKUs cannot modify quantity information。"
                              },
                              "quantity": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "quantity value. The quantity information of approved SKUs cannot be modified."
                              }
                            },
                            "required": [],
                            "additionalProperties": false,
                            "description": "SKU dimension quantity information This interface input field “ filled_quantity_to_sku”=\"true\" allows values to be passed in this field. For more quantity input examples, refer to FAQ"
                          },
                          "package_type": {
                            "type": "string",
                            "description": "SKU dimension packaging type. Fill in the field fill_configuration_tags with PACKAGE_TYPE_TO_SKU in this interface, then the field can be filled, and values 0-4 can be passed; Enumeration values: 0: Clear packaging 1: Soft packaging + soft items, 2: Soft packaging + hard items, 3: Hard packaging, 4: Vacuum)."
                          },
                          "minimum_stock_quantity": {
                            "type": "string",
                            "description": "Minimum stock quantity。 Only integers are supported, range: [1，1000000] 。 Whether the value can be passed needs to be confirmed through the product release specification API , \" field_k ey \":\" minimum_stock_quantity \",\"required\":\"true\" is mandatory, \"show\":\"false\" cannot be passed"
                          }
                        },
                        "required": [
                          "height",
                          "length",
                          "width",
                          "weight",
                          "mall_state",
                          "supplier_sku",
                          "stock_info_list"
                        ],
                        "additionalProperties": false,
                        "description": "SKU list. A maximum of 400 SKUs per SKC. 1. If there are no SKUs under an SKC (only color, no size), the SKU list data must still be provided. The sales attributes of the SKU should be treated as empty, but in this case, only one SKU is allowed per SKC. 2. For SKUs under each SKC, the number of sales attributes and attribute values must remain consistent. For example: Color/Red-Size S, Size M; Color/White-Size S, Size",
                        "anyOf": [
                          {
                            "required": [
                              "price_info_list"
                            ]
                          },
                          {
                            "required": [
                              "cost_info"
                            ]
                          }
                        ]
                      },
                      "description": "SKU list. A maximum of 400 SKUs per SKC. 1. If there are no SKUs under an SKC (only color, no size), the SKU list data must still be provided. The sales attributes of the SKU should be treated as empty, but in this case, only one SKU is allowed per SKC. 2. For SKUs under each SKC, the number of sales attributes and attribute values must remain consistent. For example: Color/Red-Size S, Size M; Color/White-Size S, Size"
                    },
                    "suggested_retail_price": {
                      "type": "object",
                      "properties": {
                        "currency": {
                          "type": "string",
                          "description": "Currency abbreviation。 Available currency list: USD, CNY, EUR, SAR, AED, CAD, MXN, HKD, VND, THB, GBP, INR, BRL, TRY, NZD. Currently, there is no interface for dynamically querying available currencies."
                        },
                        "price": {
                          "type": "number",
                          "description": "Price。 Only positive numbers are supported, cannot be equal to 0, up to 2 decimal places (Japanese yen does not support decimals)."
                        }
                      },
                      "required": [],
                      "additionalProperties": false,
                      "description": "Suggested retail price. Not available for all merchants, must be confirmed via product publishing specification endpoint , where \" field_key \":\" suggest_price \",\"required\":\"true\" indicates it is mandatory, and \"show\":\"false\" indicates it cannot be sent. Can be sent for newly published products/added SKCs, but not in editing scenarios."
                    },
                    "site_detail_image_info_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "image_group_code": {
                            "type": "string",
                            "description": "Image group code。 Cannot be passed in new scenarios, but is mandatory when updating a published SKC in edit scenarios (unless review fails). Obtain it via Query SPU Details 。"
                          },
                          "site_abbr_list": {
                            "type": "array",
                            "items": {
                              "type": "string",
                              "description": "List of sites"
                            },
                            "description": "List of sites"
                          },
                          "image_info_list": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "image_item_id": {
                                  "type": "string",
                                  "description": "Do not send the first added detail images, if you need to change existing detail images, send the image group ID"
                                },
                                "image_sort": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "Sorting"
                                },
                                "image_url": {
                                  "type": "string",
                                  "description": "Image link Must be a SHEIN format URL, which can be obtained through External link conversion or Local image upload . Use type=7 for conversion."
                                }
                              },
                              "required": [],
                              "additionalProperties": false,
                              "description": "Picture information"
                            },
                            "description": "Picture information"
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "Site detail image list. Image requirements: Upload 3:4 images, images with pixels greater than 900px, up to 10 images can be supported. Some merchants cannot upload images, please check the product release specifications. If \"field_key\": \"product_detail_pic\" has show as false, it means images cannot be uploaded."
                      },
                      "description": "Site detail image list. Image requirements: Upload 3:4 images, images with pixels greater than 900px, up to 10 images can be supported. Some merchants cannot upload images, please check the product release specifications. If \"field_key\": \"product_detail_pic\" has show as false, it means images cannot be uploaded."
                    },
                    "proof_of_stock_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "file_name": {
                            "type": "string",
                            "description": "File name"
                          },
                          "type": {
                            "type": "string",
                            "description": "File type. 1: Image; 2: PDF"
                          },
                          "url": {
                            "type": "string",
                            "description": "File link."
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "Proof of stock. Required for some merchants, confirmed via product release specification interface , \" field_key \":\" proof_of_stock \",\"required\":\"true\" when required, \"show\":\"false\" when not allowed Supports image, PDF format files, size not exceeding 3M, total number of images/files not exceeding 1."
                      },
                      "description": "Proof of stock. Required for some merchants, confirmed via product release specification interface , \" field_key \":\" proof_of_stock \",\"required\":\"true\" when required, \"show\":\"false\" when not allowed Supports image, PDF format files, size not exceeding 3M, total number of images/files not exceeding 1."
                    },
                    "shelf_require": {
                      "type": "string",
                      "description": "Whether it is mandatory to arrive at the SHEIN warehouse before being listed. 0: No, 1: Yes. Mandatory in full management mode, for other modes, confirm whether it is mandatory through the product publishing specification interface , \" field_k ey \":\" shelf_require \",\"required\":\"true\" is mandatory, \"show\":\"false\" cannot be transmitted."
                    },
                    "shelf_way": {
                      "type": "string",
                      "description": "Listing method。1-Automatic listing；2-Scheduled listing。Mandatory for fully managed and semi-managed merchants"
                    },
                    "hope_on_sale_date": {
                      "type": "string",
                      "description": "Expected listing date。 When shelf_way=2-Scheduled listing, hope_on_sale_date is mandatory, otherwise it is not filled; the time should be given to the second, and the value should be given according to Beijing time, e.g.:2022-03-21 00:00:00。"
                    }
                  },
                  "required": [
                    "image_info",
                    "sale_attribute",
                    "supplier_code",
                    "sku_list"
                  ],
                  "additionalProperties": false,
                  "description": "SKC list. Up to 40 SKCs per SPU. When the main sales attribute filling rule is set to \"Not required\" (i.e., main_attribute_status=1 in /open-api/goods/query-attribute-template), only one SKC is allowed per SPU."
                },
                "description": "SKC list. Up to 40 SKCs per SPU. When the main sales attribute filling rule is set to \"Not required\" (i.e., main_attribute_status=1 in /open-api/goods/query-attribute-template), only one SKC is allowed per SPU."
              },
              "sale_attribute_sort_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "attribute_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Attribute name ID"
                    },
                    "in_order_attribute_value_id_list": {
                      "type": "array",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991,
                        "description": "Attribute value ID sorting list 。 The list is arranged in the desired order to ensure that the order of attribute values on the product details page matches the order in the incoming parameters 。"
                      },
                      "description": "Attribute value ID sorting list 。 The list is arranged in the desired order to ensure that the order of attribute values on the product details page matches the order in the incoming parameters 。"
                    },
                    "in_order_attribute_value_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "attribute_value_id": {
                            "type": "string",
                            "description": "Attribute value ID"
                          },
                          "custom_attribute_value": {
                            "type": "string",
                            "description": "The content of the custom attribute value. The input content must be exactly the same as the attribute value filled in the sales attributes."
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "A sorted list of attribute value IDs/custom attribute value notes. If there are custom attribute values under an attribute, this field must be used. Use the corresponding field for the type of attribute value, and input them in order according to the sorting. See the documentation for detailed usage."
                      },
                      "description": "A sorted list of attribute value IDs/custom attribute value notes. If there are custom attribute values under an attribute, this field must be used. Use the corresponding field for the type of attribute value, and input them in order according to the sorting. See the documentation for detailed usage."
                    }
                  },
                  "required": [
                    "attribute_id"
                  ],
                  "additionalProperties": false,
                  "description": "Sales attribute sorting。 Set the display order of attribute values on the consumer product details page。 Please call the 【 Product Release Field Specifications (including default language) 】 API, and determine whether this sales attribute supports sorting based on the field support_sale_attribute_sort。 Primary sales attributes support sorting by default。"
                },
                "description": "Sales attribute sorting。 Set the display order of attribute values on the consumer product details page。 Please call the 【 Product Release Field Specifications (including default language) 】 API, and determine whether this sales attribute supports sorting based on the field support_sale_attribute_sort。 Primary sales attributes support sorting by default。"
              },
              "sample_info": {
                "type": "object",
                "properties": {
                  "sample_spec": {
                    "type": "object",
                    "properties": {
                      "main_spec": {
                        "type": "object",
                        "properties": {
                          "attribute_id": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Main sales attribute id"
                          },
                          "attribute_value_id": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Main sales attribute value id"
                          },
                          "attribute_value_name": {
                            "type": "string",
                            "description": "Custom attribute value of the main sales attribute"
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "Main sales attribute information of the sample。"
                      },
                      "sub_spec_list": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "attribute_id": {
                              "type": "string",
                              "description": "Secondary sales attribute id"
                            },
                            "attribute_value_id": {
                              "type": "string",
                              "description": "Secondary sales attribute value id"
                            },
                            "attribute_value_name": {
                              "type": "string",
                              "description": "Custom attribute value of the secondary sales attribute"
                            }
                          },
                          "required": [],
                          "additionalProperties": false,
                          "description": "Information on the secondary sales attributes of the sample; common ones are size"
                        },
                        "description": "Information on the secondary sales attributes of the sample; common ones are size"
                      }
                    },
                    "required": [],
                    "additionalProperties": false,
                    "description": "Sample specification"
                  },
                  "sample_judge_type": {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991,
                    "description": "Approval type (2: Bulk fabric samples), fixed as 2"
                  },
                  "reserve_sample_flag": {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991,
                    "description": "Sample retention (1: Yes; 2: No), fixed as 2"
                  },
                  "spot_flag": {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991,
                    "description": "Whether in stock(1:yes;2:no)"
                  }
                },
                "required": [],
                "additionalProperties": false,
                "description": "Sample information。 Whether values can be passed needs to be confirmed via the Product Release Specifications API 。 When \" field_k ey \":\" sample_spec \",\"required\":\"true\", it is mandatory。 When sample information is mandatory, the outermost size_attribute_list also needs to be passed。"
              }
            },
            "required": [
              "category_id",
              "multi_language_name_list",
              "product_attribute_list",
              "skc_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/product/partialEdit": {
      "id": 3002019,
      "method": "POST",
      "path": "/open-api/goods/product/partialEdit",
      "risk": "H",
      "description": "Partial product editing. Partial editing follows the published field rules. Inspect audit status after submission; do not infer publication from acknowledgement. Applicable application modes: 1, 2, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002019",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "spu_name": {
                "type": "string",
                "description": "The unique SPU code generated by the platform。Required。"
              },
              "category_id": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Last level category id。"
              },
              "product_type_id": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Product type id。"
              },
              "supplier_code": {
                "type": "string",
                "description": "Merchant product number, down to the main specification granularity, up to 200 characters"
              },
              "brand_code": {
                "type": "string",
                "description": "Brand code available for the store。"
              },
              "ip_character_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "ip_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "The IP ID. If ip_character_list is provided, ip_id is required。"
                    },
                    "ip_name": {
                      "type": "string",
                      "description": "The English name of the IP"
                    },
                    "ip_name_cn": {
                      "type": "string",
                      "description": "The Chinese name of the IP"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "Product IP. Currently, each product only supports binding 1 IP。 The IPs available to the store can be obtained via the API：/open-api/goods/query-ip-list。Whether the store can pass IP needs to be confirmed through the standard API; \"show\": true in \"ip_character\" indicates it can be passed。"
                },
                "description": "Product IP. Currently, each product only supports binding 1 IP。 The IPs available to the store can be obtained via the API：/open-api/goods/query-ip-list。Whether the store can pass IP needs to be confirmed through the standard API; \"show\": true in \"ip_character\" indicates it can be passed。"
              },
              "is_spu_pic": {
                "type": "boolean",
                "description": "Whether to use the new image scheme. true-use new scheme, false-use old scheme. If switching from false to true, all types of images at all levels required in the new scheme must be submitted."
              },
              "image_info": {
                "type": "object",
                "properties": {
                  "image_group_code": {
                    "type": "string",
                    "description": "The unique code of the image group, generated by the platform。"
                  },
                  "image_info_list": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "image_item_id": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "The unique code of the image, generated by the platform。"
                        },
                        "image_sort": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Image sorting. The serial number values within the same image group cannot be repeated. The sort of type=1 images must be 1."
                        },
                        "image_type": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Image types. 1-Main image, 2-Detail image, 5-Block image, 6-Color block image. For details on which types of images are required, quantity limits, and size requirements for each type of image, please refer to Product Image Plan ."
                        },
                        "image_url": {
                          "type": "string",
                          "description": "Image link. It must be a SHEIN format URL, which can be obtained through External Link Conversion or Local Image Upload ."
                        }
                      },
                      "required": [],
                      "additionalProperties": false,
                      "description": "Image details"
                    },
                    "description": "Image details"
                  }
                },
                "required": [
                  "image_info_list"
                ],
                "additionalProperties": false,
                "description": "SPU image list。 Editing is only allowed when the product originally allows SPU images (i.e., the product's original is_spu_pic=true )."
              },
              "multi_language_name_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "language": {
                      "type": "string",
                      "description": "Language. If a value is passed, the default language must be provided, and the default language must be obtained through the Product Release Specification API default_language."
                    },
                    "name": {
                      "type": "string",
                      "description": "Product name, up to 1000 characters, emoji not supported."
                    }
                  },
                  "required": [
                    "language",
                    "name"
                  ],
                  "additionalProperties": false,
                  "description": "Product name list ( Supports multiple languages) This field cannot be left empty, an error will occur if the field is passed as \"\" during editing."
                },
                "description": "Product name list ( Supports multiple languages) This field cannot be left empty, an error will occur if the field is passed as \"\" during editing."
              },
              "multi_language_desc_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "language": {
                      "type": "string",
                      "description": "Language. If a value is passed, the default language must be provided, and the default language must be obtained through the Product Release Specification API default_language."
                    },
                    "name": {
                      "type": "string",
                      "description": "Multilingual description, up to 5000 characters, emojis are not supported."
                    }
                  },
                  "required": [
                    "language",
                    "name"
                  ],
                  "additionalProperties": false,
                  "description": "Product description list (supports multiple languages)"
                },
                "description": "Product description list (supports multiple languages)"
              },
              "product_attribute_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "attribute_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Attribute ID。 Only attributes with attribute_type=3/4 can be entered in product attributes。 There are 2 types of required product attributes: First, attributes with attribute_status=3, confirmed through store available attributes; second, associated attributes that are required because selecting attribute A makes attribute B mandatory, confirmed through Query Associated Attributes filling rules。"
                    },
                    "attribute_value_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Attribute value ID. When the input method of the attribute is attribute_mode=1/3/4, the parameter needs to be passed here. When attribute_mode=3 (dropdown single selection), it means that there can only be one attribute value ID under the attribute ID; when attribute_mode=1 (dropdown multiple selection)/4 (dropdown multiple selection + manual input), it means that there can be N attribute value IDs under the attribute ID. For multiple selections, each attribute value needs to be passed as a separate set of data. This field does not support arrays. The maximum number of selectable attribute values is determined by the attribute attribute_input_num."
                    },
                    "attribute_extra_value": {
                      "type": "string",
                      "description": "Attribute value (manual input type)。 When the input method of the attribute attribute_mode=0/4, it needs to be entered here。Positive integers and text input are supported When attribute_type=3 and attribute_mode=4 (dropdown multi-select + manual input), the sum of manual input values of multiple attribute values under the same attribute ID must = 100。For example, component attribute, component A contains 10, component B contains 90。"
                    }
                  },
                  "required": [
                    "attribute_id"
                  ],
                  "additionalProperties": false,
                  "description": "Product attribute list. If you want to update product attribute information, you need to submit the complete attribute list. This list can only include attribute_type=3/4 attributes. For attribute usage instructions, please refer to the Product Attribute Document ."
                },
                "description": "Product attribute list. If you want to update product attribute information, you need to submit the complete attribute list. This list can only include attribute_type=3/4 attributes. For attribute usage instructions, please refer to the Product Attribute Document ."
              },
              "size_attribute_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "attribute_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Attribute ID。 This field can only be entered for attributes with attribute_type=2 。"
                    },
                    "attribute_value_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Attribute value ID. Size attributes do not need to pass this value, it needs to be given in attribute_extra_value."
                    },
                    "attribute_extra_value": {
                      "type": "string",
                      "description": "Attribute value (manual input type). When the input method of the attribute is attribute_mode=0/4, the parameter needs to be passed here. Only positive integers are supported."
                    },
                    "relate_sale_attribute_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Associated sales attribute ID. Size attributes can be associated with sales attributes to form a size chart. Note: Only SKU dimension attributes can be associated. For example, size: size attribute: length, sales attribute: size-S, the combination forms a complete size chart."
                    },
                    "relate_sale_attribute_value_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Associated sales attribute value ID. Note: Can only be associated with sku dimension attributes."
                    },
                    "relate_sale_attribute_value": {
                      "type": "string",
                      "description": "Associated custom attribute values. When the attribute value of the SKU is a custom attribute value, pass the parameter here, and the content needs to be consistent with the SKU attribute value. If the value form is used in the SKU attribute value, the value form must also be used here. For usage details, see the document."
                    }
                  },
                  "required": [
                    "attribute_id"
                  ],
                  "additionalProperties": false,
                  "description": "Size attribute (size chart)。 Note: If the product already has a size chart, and the attribute values of the SKUs under the product increase during partial editing, new size chart data must be submitted simultaneously. For example, if the SKU was originally size-S, size-M, and size-L was added in this submission, the size chart containing S, M, L must also be submitted. Size input method please refer to Product Attribute Document。"
                },
                "description": "Size attribute (size chart)。 Note: If the product already has a size chart, and the attribute values of the SKUs under the product increase during partial editing, new size chart data must be submitted simultaneously. For example, if the SKU was originally size-S, size-M, and size-L was added in this submission, the size chart containing S, M, L must also be submitted. Size input method please refer to Product Attribute Document。"
              },
              "sale_attribute_sort_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "attribute_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Property Name ID"
                    },
                    "in_order_attribute_value_id_list": {
                      "type": "array",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991,
                        "description": "Attribute value ID sorting list。 The list is arranged in the desired order to ensure that the order on the product detail page is consistent with the order of attribute values in the input parameters。"
                      },
                      "description": "Attribute value ID sorting list。 The list is arranged in the desired order to ensure that the order on the product detail page is consistent with the order of attribute values in the input parameters。"
                    },
                    "in_order_attribute_value_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "attribute_value_id": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Attribute value ID"
                          },
                          "custom_attribute_value": {
                            "type": "string",
                            "description": "The content of the custom attribute value. The input parameter content must be exactly the same as the attribute value filled in the sales attributes."
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "Sorted attribute value ID/custom attribute value remark list. If there are custom attribute values under the attribute, this field is required. Enter the corresponding field below according to the form of the attribute value, and input in order. For usage details, see the document."
                      },
                      "description": "Sorted attribute value ID/custom attribute value remark list. If there are custom attribute values under the attribute, this field is required. Enter the corresponding field below according to the form of the attribute value, and input in order. For usage details, see the document."
                    }
                  },
                  "required": [
                    "attribute_id"
                  ],
                  "additionalProperties": false,
                  "description": "Sales attribute sorting. Note: If the product originally has a custom sorting, when adding SKC or SKU during partial editing, the complete sorting value needs to be submitted at the same time."
                },
                "description": "Sales attribute sorting. Note: If the product originally has a custom sorting, when adding SKC or SKU during partial editing, the complete sorting value needs to be submitted at the same time."
              },
              "skc_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "skc_name": {
                      "type": "string",
                      "description": "SKC unique code, generated by the platform. Required when editing SKC."
                    },
                    "sale_attribute": {
                      "type": "object",
                      "properties": {
                        "attribute_id": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Sales Attribute ID"
                        },
                        "attribute_value_id": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Sales attribute value ID"
                        },
                        "custom_attribute_value": {
                          "type": "string",
                          "description": "自定义属性值。 使用方式详见文档。 仅在销售属性ID支持自定义属性值时，才可在此字段内入参，可通过 /open-api/goods/get-custom-attribute-permission-config确认。 属性值要求：字符数50以内；支持半角符号，不可输入全角符号；不支持unicode，检验表达式可参考：String emojiPattern = \"[\\\\uD83C-\\\\uDBFF\\\\uDC00-\\\\uDFFF\\\\u2600-\\\\u27ff]\""
                        },
                        "language": {
                          "type": "string",
                          "description": "Language of custom attribute values. Supported languages: en, zh-cn, fr, es, it. If ERP does not pass multilingual content, the platform will perform system translation."
                        }
                      },
                      "required": [],
                      "additionalProperties": false,
                      "description": "SKC sales attribute。 This field can only be used for attributes with attribute_type=1 and attribute_label=1。Mandatory sales attributes exist, attribute_status=3 is a mandatory attribute, confirmed through Available store attributes 。"
                    },
                    "skc_title": {
                      "type": "string",
                      "description": "SKC dimension product title。 Mandatory for some merchants, confirmed through Product release specification API , \" field_key \":\"skc_title\",\"required\":\"true\" is mandatory, \" show \":\"false\" cannot be passed。Provide the title in the default language。Not passing the field during editing means clearing the data。"
                    },
                    "supplier_code": {
                      "type": "string",
                      "description": "Merchant-side SKC dimension item number, up to 200 characters"
                    },
                    "image_info": {
                      "type": "object",
                      "properties": {
                        "image_group_code": {
                          "type": "string",
                          "description": "The unique code of the image group, generated by the platform。"
                        },
                        "image_info_list": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "image_item_id": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "The unique code of the image, generated by the platform。"
                              },
                              "image_sort": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "Image sorting. The serial number values within the same image group cannot be repeated. The sort of type=1 images must be 1."
                              },
                              "image_type": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "Image types. 1-Main image, 2-Detail image, 5-Block image, 6-Color block image. For details on which types of images are required, quantity limits, and size requirements for each type of image, please refer to Product Image Plan ."
                              },
                              "image_url": {
                                "type": "string",
                                "description": "Image link. It must be a SHEIN format URL, which can be obtained through External Link Conversion or Local Image Upload ."
                              }
                            },
                            "required": [
                              "image_sort",
                              "image_type",
                              "image_url"
                            ],
                            "additionalProperties": false,
                            "description": "Image details"
                          },
                          "description": "Image details"
                        }
                      },
                      "required": [
                        "image_info_list"
                      ],
                      "additionalProperties": false,
                      "description": "SKC image list"
                    },
                    "site_detail_image_info_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "image_group_code": {
                            "type": "string",
                            "description": "The unique code of the image group, generated by the platform。 Required when editing and can be obtained through /open-api/goods/spu-info."
                          },
                          "image_info_list": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "image_item_id": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "The unique code of the image, generated by the platform。"
                                },
                                "image_sort": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "Image sorting. Sequence values in the same image group cannot be repeated."
                                },
                                "image_url": {
                                  "type": "string",
                                  "description": "Image link. It must be a SHEIN format URL, which can be obtained through External Link Conversion or Local Image Upload ."
                                }
                              },
                              "required": [
                                "image_sort",
                                "image_url"
                              ],
                              "additionalProperties": false,
                              "description": "Image details"
                            },
                            "description": "Image details"
                          },
                          "site_abbr_list": {
                            "type": "array",
                            "items": {
                              "type": "string",
                              "description": "Site list"
                            },
                            "description": "Site list"
                          }
                        },
                        "required": [
                          "image_info_list",
                          "site_abbr_list"
                        ],
                        "additionalProperties": false,
                        "description": "SKC site detail image list。 All images passed in are type=7."
                      },
                      "description": "SKC site detail image list。 All images passed in are type=7."
                    },
                    "suggested_retail_price": {
                      "type": "object",
                      "properties": {
                        "currency": {
                          "type": "string",
                          "description": "Currency abbreviation。 The currencies available to merchants are the 【currency】 in the Product Release Specification 。（Currently, JPY is not supported, USD can be used temporarily）"
                        },
                        "price": {
                          "type": "number",
                          "description": "Price. Up to 2 decimal places (Japanese yen does not support decimals)."
                        }
                      },
                      "required": [
                        "currency",
                        "price"
                      ],
                      "additionalProperties": false,
                      "description": "Suggested retail price。Not all merchants can use it, whether the value can be passed needs to be confirmed through the Product Release Specification API , \" field_key \":\" suggest_price \",\"required\":\"true\" must be filled in, \"show\":\"false\" cannot be passed Can be passed when adding SKC, cannot be passed in editing scenarios。"
                    },
                    "shelf_require": {
                      "type": "string",
                      "description": "Whether mandatory delivery to SHEIN warehouse is required。0: No, 1: Yes。 Mandatory in full management mode, whether mandatory in other modes must be verified through the Product Release Specification Interface , \" field_k ey \":\" shelf_require \",\"required\":\"true\" is mandatory, \"show\":\"false\" cannot be transmitted"
                    },
                    "shelf_way": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Listing method. 1-Automatic listing; 2-Scheduled listing. Mandatory for fully managed and semi-managed merchants."
                    },
                    "hope_on_sale_date": {
                      "type": "string",
                      "description": "Expected listing time. When shelf_way=2-Scheduled listing, hope_on_sale_date is required, otherwise it is not filled; Time is given to hours, minutes, and seconds, values are given in Beijing time, e.g.:2022-03-21 00:00:00."
                    },
                    "proof_of_stock_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "file_name": {
                            "type": "string",
                            "description": "File name"
                          },
                          "type": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "File type. 1: Image; 2: PDF"
                          },
                          "url": {
                            "type": "string",
                            "description": "File link."
                          }
                        },
                        "required": [
                          "file_name",
                          "type",
                          "url"
                        ],
                        "additionalProperties": false,
                        "description": "Stock proof。 Mandatory for some merchants, must be verified through the Product Release Specification Interface , \" field_k ey \":\" proof_of_stock \",\"required\":\"true\" is mandatory, \"show\":\"false\" cannot be transmitted Supports image, PDF format files, size must not exceed 3M, total number of images/files must not exceed 1"
                      },
                      "description": "Stock proof。 Mandatory for some merchants, must be verified through the Product Release Specification Interface , \" field_k ey \":\" proof_of_stock \",\"required\":\"true\" is mandatory, \"show\":\"false\" cannot be transmitted Supports image, PDF format files, size must not exceed 3M, total number of images/files must not exceed 1"
                    },
                    "sku_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "sku_code": {
                            "type": "string",
                            "description": "SKU unique code, generated by the platform. Required when editing SKU."
                          },
                          "sale_attribute_list": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "attribute_id": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "Sales Attribute ID"
                                },
                                "attribute_value_id": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "Sales attribute value ID"
                                },
                                "custom_attribute_value": {
                                  "type": "string",
                                  "description": "自定义属性值。 使用方式详见文档。 仅在销售属性ID支持自定义属性值时，才可在此字段内入参，可通 过/open-api/goods/get-custom-attribute-permission-config确认。 属性值要求：字符数50以内；支持半角符号，不可输入全角符号；不支持unicode，检验表达式可参考：String emojiPattern = \"[\\\\uD83C-\\\\uDBFF\\\\uDC00-\\\\uDFFF\\\\u2600-\\\\u27ff]\""
                                },
                                "language": {
                                  "type": "string",
                                  "description": "Language of custom attribute values. Supported languages: en, zh-cn, fr, es, it. If ERP does not pass multilingual content, the platform will perform system translation."
                                }
                              },
                              "required": [
                                "attribute_id"
                              ],
                              "additionalProperties": false,
                              "description": "SKU销售属性列表。 只能入参 attribute_type=1 且 attribute_label=0/1的属性。attribute_status=3为必填属性，需通过 店铺可用属性 确认； SKC下无SKU时，销售属性给空；若有SKU，最多有2个属性，且不同SKC下SKU属性数量需相同。新增SKU时必传，编辑场景不可修改。"
                            },
                            "description": "SKU销售属性列表。 只能入参 attribute_type=1 且 attribute_label=0/1的属性。attribute_status=3为必填属性，需通过 店铺可用属性 确认； SKC下无SKU时，销售属性给空；若有SKU，最多有2个属性，且不同SKC下SKU属性数量需相同。新增SKU时必传，编辑场景不可修改。"
                          },
                          "supplier_sku": {
                            "type": "string",
                            "description": "Merchant-maintained SKU code。 supplier_sku must be unique within the store and cannot be repeated 。1 supplier_sku corresponds to only 1 platform SKU, up to 200 characters。You can confirm whether the entered value already exists in the store through the interface: /open-api/goods/product/check-supplierSku-repeated"
                          },
                          "length": {
                            "type": "string",
                            "description": "Including packaging dimensions: length (cm)。 Supports input of positive numbers, up to 2 decimal places。"
                          },
                          "width": {
                            "type": "string",
                            "description": "Package dimensions: Width (cm)。 Supports positive numbers, up to 2 decimal places。"
                          },
                          "height": {
                            "type": "string",
                            "description": "Package dimensions: Height (cm)。 Supports positive numbers, up to 2 decimal places。"
                          },
                          "weight": {
                            "type": "number",
                            "description": "Including packaging weight: weight (g)。 Supports input of positive integers, 0 cannot be entered"
                          },
                          "weight_unit": {
                            "type": "string"
                          },
                          "length_width_height_unit": {
                            "type": "string"
                          },
                          "mall_state": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "SKU mall sales status。 1. On sale; 2. Off sale; Note: If the SKU is set to off sale, the inventory quantity of the SKU will not be saved, and the inventory quantity will be displayed as empty in the merchant backend"
                          },
                          "stop_purchase": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Procurement status (only available for fully managed). 1: Available for procurement, 2: Procurement stopped"
                          },
                          "quantity_info": {
                            "type": "object",
                            "properties": {
                              "quantity": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "Quantity value。 The quantity information of approved SKUs cannot be modified。"
                              },
                              "quantity_type": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "Quantity type. 1-Single piece 2-Multiple pieces of the same item. The quantity information of approved SKUs cannot be modified."
                              },
                              "quantity_unit": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991,
                                "description": "Unit of quantity. 1-Piece 2-Pair All SKUs under the same SKC must maintain the same unit of quantity. The quantity information of approved SKUs cannot be modified."
                              }
                            },
                            "required": [
                              "quantity",
                              "quantity_type",
                              "quantity_unit"
                            ],
                            "additionalProperties": false,
                            "description": "SKU dimension quantity information If the product already has SKU dimension quantity, when adding SKC or SKU in partial editing, all new SKUs need to provide quantity。"
                          },
                          "package_type": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "SKU dimension packaging type. Enumeration values: 0: Clear packaging 1: Soft packaging + soft items, 2: Soft packaging + hard items, 3: Hard packaging, 4: Vacuum. If the product already has SKU dimension packaging type, when adding SKC or SKU during partial editing, all newly added SKUs must provide packaging type."
                          },
                          "supplier_barcode": {
                            "type": "object",
                            "properties": {
                              "barcode": {
                                "type": "string",
                                "description": "Product barcode。Regardless of the barcode type, only numbers are supported, up to 32 digits。 Under the same SKC, barcodes in SKU cannot be repeated。"
                              },
                              "barcode_type": {
                                "type": "string",
                                "description": "Barcode type. Enumerated values: EAN, UPC"
                              }
                            },
                            "required": [
                              "barcode",
                              "barcode_type"
                            ],
                            "additionalProperties": false,
                            "description": "Merchant barcode。Only available for some merchants, needs to be confirmed through the interface： /open-api/goods/query-publish-fill-in-standard ，supplier_barcode's show=true in the response indicates it can be filled。"
                          },
                          "image_info": {
                            "type": "object",
                            "properties": {
                              "image_group_code": {
                                "type": "string",
                                "description": "The unique code of the image group, generated by the platform。 Required when editing and can be obtained through /open-api/goods/spu-info."
                              },
                              "image_info_list": {
                                "type": "array",
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "image_item_id": {
                                      "type": "integer",
                                      "minimum": -9007199254740991,
                                      "maximum": 9007199254740991,
                                      "description": "The unique code of the image, generated by the platform。 If providing a new image, it can be left blank; if providing an old image, it needs to be filled in and can be obtained through /open-api/goods/spu-info."
                                    },
                                    "image_sort": {
                                      "type": "integer",
                                      "minimum": -9007199254740991,
                                      "maximum": 9007199254740991,
                                      "description": "Image sorting. The serial number values within the same image group cannot be repeated. The sort of type=1 images must be 1."
                                    },
                                    "image_type": {
                                      "type": "integer",
                                      "minimum": -9007199254740991,
                                      "maximum": 9007199254740991,
                                      "description": "Image type. SKU images can only be type=1 images."
                                    },
                                    "image_url": {
                                      "type": "string",
                                      "description": "Image link. It must be a SHEIN format URL, which can be obtained through External Link Conversion or Local Image Upload ."
                                    }
                                  },
                                  "required": [],
                                  "additionalProperties": false,
                                  "description": "Image details"
                                },
                                "description": "Image details"
                              }
                            },
                            "required": [
                              "image_info_list"
                            ],
                            "additionalProperties": false,
                            "description": "SKU image list。 If the product originally has SKU images, when adding SKC or SKU during partial editing, all new SKUs must provide SKU images"
                          },
                          "price_info_list": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "base_price": {
                                  "type": "number",
                                  "description": "Original price。 Only numbers are supported, up to 2 decimal places (Japanese yen does not support decimals)。The original price must be greater than the special price。"
                                },
                                "currency": {
                                  "type": "string",
                                  "description": "Currency abbreviation. Currency is bound to the site, for example, the US site currency is given as USD. The currency of each site can be obtained through Query Site Currency ."
                                },
                                "special_price": {
                                  "type": "number",
                                  "description": "Special price. Only numbers are supported, up to 2 decimal places (Japanese Yen does not support decimals). The special price must be lower than the original price."
                                },
                                "sub_site": {
                                  "type": "string",
                                  "description": "Site (sub-site). The range of sites where the store can be listed can be obtained through Query Site Currency . Use site_status=1 (enabled) site_abbr here."
                                }
                              },
                              "required": [
                                "base_price",
                                "currency",
                                "sub_site"
                              ],
                              "additionalProperties": false,
                              "description": "Price information (for self-operation and POP use only) Mandatory when adding SKC/SKU, not allowed when editing。 To update the price of published SKUs, adjust through 【 Update product price 】。 Price is provided based on the dimension of the listing site。"
                            },
                            "description": "Price information (for self-operation and POP use only) Mandatory when adding SKC/SKU, not allowed when editing。 To update the price of published SKUs, adjust through 【 Update product price 】。 Price is provided based on the dimension of the listing site。"
                          },
                          "cost_info": {
                            "type": "object",
                            "properties": {
                              "cost_price": {
                                "type": "string",
                                "description": "Supply price. Up to 2 decimal places. Numbers must be between 0-100000. Negative numbers cannot be entered."
                              },
                              "currency": {
                                "type": "string",
                                "description": "Currency abbreviation。 The currencies available to merchants are the 【currency】 in the Product Release Specification"
                              }
                            },
                            "required": [
                              "cost_price",
                              "currency"
                            ],
                            "additionalProperties": false,
                            "description": "SKU supply price Applicable application modes: semi-managed, fully managed. Mandatory when adding SKCSKU, not allowed during editing. If you need to update the SKU supply price that has been approved, you need to call the 【 Update Supply Price 】API to modify it."
                          },
                          "stock_info_list": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "inventory_num": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "Total product inventory。Can be 0，"
                                },
                                "supplier_warehouse_id": {
                                  "type": "integer",
                                  "minimum": -9007199254740991,
                                  "maximum": 9007199254740991,
                                  "description": "Merchant warehouse ID 。 If the store has multiple warehouses, this field is required ，can be obtained through the 【 Merchant Warehouse List Query 】API"
                                },
                                "supplier_warehouse_name": {
                                  "type": "string",
                                  "description": "Merchant warehouse name。 Can be obtained through the 【 Merchant Warehouse List Query 】API。"
                                }
                              },
                              "required": [
                                "inventory_num"
                              ],
                              "additionalProperties": false,
                              "description": "Inventory information Mandatory when adding SKC/SKU, not allowed in editing scenarios. To update inventory, use Modify Inventory (Self-operated & Semi-managed) , Purchaser Inventory Update (Fully Managed) to process."
                            },
                            "description": "Inventory information Mandatory when adding SKC/SKU, not allowed in editing scenarios. To update inventory, use Modify Inventory (Self-operated & Semi-managed) , Purchaser Inventory Update (Fully Managed) to process."
                          },
                          "competing_product_link": {
                            "type": "string",
                            "description": "商品信息参考链接。 部分商家必填， 通过 商品发布规范接口 确认，\" field_key \":\" reference_product_link \",\"required\":\"true\"时必填，\" show \":\"false\"时不可传。链接字符长度不超过300。编辑时不穿字段代表清空数据。"
                          },
                          "minimum_stock_quantity": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Minimum stock quantity。Only integers are supported, range: [1，1000000] 。 Whether the value can be passed needs to be confirmed through the Product Release Specification API , \" field_k ey \":\" minimum_stock_quantity \",\"required\":\"true\" must be filled in, \"show\":\"false\" cannot be passed"
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "SKU list。"
                      },
                      "description": "SKU list。"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "SKC information list. A maximum of 40 SKCs under one SPU."
                },
                "description": "SKC information list. A maximum of 40 SKCs under one SPU."
              },
              "product_video_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "sites": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "description": "Sub-site. One video can be bound to multiple sites, but one site can only be bound to one video。"
                      },
                      "description": "Sub-site. One video can be bound to multiple sites, but one site can only be bound to one video。"
                    },
                    "video_url": {
                      "type": "string",
                      "description": "Video link。The video must be converted by the platform before it can be used. The product video is bound at the site dimension, and each site is allowed to bind only one video。For how to use the video, see the documentation。"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "Product video. The video must be converted by the platform before it can be used. The product video is bound at the site level, and each site is only allowed to bind one video. How to use the video ， see the documentation。"
                },
                "description": "Product video. The video must be converted by the platform before it can be used. The product video is bound at the site level, and each site is only allowed to bind one video. How to use the video ， see the documentation。"
              }
            },
            "required": [
              "spu_name"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/goods/product/check-publish-permission": {
      "id": 3001589,
      "method": "GET",
      "path": "/open-api/goods/product/check-publish-permission",
      "risk": "R",
      "description": "Confirm whether the store can publish products. Call the API before publishing products to confirm whether the merchant's store is qualified to publish products. Stores may be unable to publish products for various reasons, mostly requiring merchants to handle this in the merchant backend. This API covers the following reasons: 1. The store is closed. That is, it cannot operate. 2. The store currently has orders prohibiting product publishing; it needs to be handled according to the platform's suggestions. 3. KYC for some sites of the store is not completed; product publishing can be done after KYC verification. 4. The shipping and return addresses for all sites of self-operated stores are not maintained; product publishing can be done after maintenance. 5. The available product quota for self-operated/semi-managed stores is 0, and the available product quota for fully managed stores is 0. 6. The store has no available listing sites. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001589",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "brandCode": {
                "type": "string",
                "description": "Brand code。Only self-operated/semi-managed merchants support input parameters, used to confirm whether the brand used for release is a quota-exempt brand。If the input brand is an exempt brand，then this product will not occupy the on-shelf quota。 This value corresponds to the brand_code in the product release interface, which can be obtained through the interface /open-api/goods/query-brand-list。"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/product/check-edit-permission": {
      "id": 3001380,
      "method": "POST",
      "path": "/open-api/goods/product/check-edit-permission",
      "risk": "R",
      "description": "Confirm whether the product is editable. Before editing a product, call the interface to confirm whether the product can be edited. Editable products must meet the following conditions: 1. The product has been initially published and approved by the platform. (If there are multiple SKCs under the initially published SPU, as long as one SKC is approved, the SPU is considered approved.) 2. If you want to edit the product under condition 1, the product should not currently be in the review document. That is, after the SPU is successfully published, editing generates document A. Before A has a review result, the SPU cannot be edited again. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001380",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "spuName": {
                "type": "string",
                "description": "Platform-generated unique SPU code"
              }
            },
            "required": [
              "spuName"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/query-document-state": {
      "id": 3001368,
      "method": "POST",
      "path": "/open-api/goods/query-document-state",
      "risk": "R",
      "description": "Check product audit status. Supports querying the review status of SKC through SPU, supports querying the review status of a specific version of SPU; meanwhile, the platform also supports pushing product review results via webhook message notifications, for details, please refer to Product Official Review Notification . Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001368",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "spuList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "spuName": {
                      "type": "string",
                      "description": "spuName, spuName are system codes generated by SHEIN"
                    },
                    "version": {
                      "type": "string",
                      "description": "Review version number. When the product is published or an edit is submitted, the response will include version ."
                    }
                  },
                  "required": [
                    "spuName"
                  ],
                  "additionalProperties": false,
                  "description": "SPU list, up to 10 SPU per transmission"
                },
                "description": "SPU list, up to 10 SPU per transmission"
              }
            },
            "required": [
              "spuList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/revoke-product": {
      "id": 3001896,
      "method": "POST",
      "path": "/open-api/goods/revoke-product",
      "risk": "D",
      "description": "Withdraw product review. This interface supports withdrawing products under review based on the SPU (Service Provider Price). Products that have passed review cannot be withdrawn. Applicable application modes: 1, 2, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001896",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "spuName": {
                "type": "string",
                "description": "spuName, spuName returned after successful product release"
              }
            },
            "required": [
              "spuName"
            ],
            "additionalProperties": false,
            "description": "OpenAPI withdraw document based on spu"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/searchProduct": {
      "id": 3001938,
      "method": "POST",
      "path": "/open-api/goods/searchProduct",
      "risk": "R",
      "description": "Comprehensive product query. The product list interface supports comprehensive queries using various conditions. Query results are provided at the SPU (Shop Unit) level, with key product information provided for each SPU. Supported conditions include: platform code, merchant-maintained item number, listing status, category, publication time, and update time; all conditions are ANDed. Returned information includes: codes and item numbers at each level, title attributes, main image, listing status, price, inventory, and marketing campaign lock. Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001938",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number, starting from 1"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page size, maximum 10"
              },
              "categoryIds": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Last-level category ID list, up to 10 at a time。"
                },
                "description": "Last-level category ID list, up to 10 at a time。"
              },
              "spuNameList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SPU code list (platform code), up to 10 at a time。"
                },
                "description": "SPU code list (platform code), up to 10 at a time。"
              },
              "skcNameList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC code list (platform code)，up to 10 at a time。"
                },
                "description": "SKC code list (platform code)，up to 10 at a time。"
              },
              "skuCodeList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKU code list (platform code)，up to 10 at a time。"
                },
                "description": "SKU code list (platform code)，up to 10 at a time。"
              },
              "skcSupplierCodeList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC item number list (merchant maintained item number)，up to 10 at a time。"
                },
                "description": "SKC item number list (merchant maintained item number)，up to 10 at a time。"
              },
              "supplierSkuList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Merchant SKU list (merchant maintained SKU item number)，up to 10 at a time"
                },
                "description": "Merchant SKU list (merchant maintained SKU item number)，up to 10 at a time"
              },
              "skcShelfStatus": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "SKC shelf status，0:Off the shelf 1:On the shelf。Pending and sold out are both considered off the shelf。"
              },
              "languageList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Language list，determines the language content returned for product information such as name，attribute name，and attribute value name。A maximum of 5 languages can be input at a time，if not provided，English is returned by default。"
                },
                "description": "Language list，determines the language content returned for product information such as name，attribute name，and attribute value name。A maximum of 5 languages can be input at a time，if not provided，English is returned by default。"
              },
              "createTimeStart": {
                "type": "string",
                "description": "SPU release time period (start time)，format yyyy-MM-dd HH:mm:ss。Release time definition: SPU first review pass time。"
              },
              "createTimeEnd": {
                "type": "string",
                "description": "SPU release time period (end time)，format yyyy-MM-dd HH:mm:ss。Release time definition: SPU first review pass time。"
              },
              "updateTimeEnd": {
                "type": "string",
                "description": "SPU update time period (end time), format yyyy-MM-dd HH:mm:ss。Update time definition: Updates caused by changes in the title, brand, IP, or attributes of any SKC under SPU. Does not include updates to price or inventory。"
              },
              "updateTimeStart": {
                "type": "string",
                "description": "SPU update time period (start time)，format yyyy-MM-dd HH:mm:ss。Update time definition: Updates caused by changes in the title, brand, IP, or attributes of any SKC under the SPU。Does not include price or inventory updates。"
              }
            },
            "required": [
              "pageNum",
              "pageSize"
            ],
            "additionalProperties": false,
            "description": "商品列表V2请求参数"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/openapi-business-backend/product/query": {
      "id": 3001239,
      "method": "POST",
      "path": "/open-api/openapi-business-backend/product/query",
      "risk": "R",
      "description": "Product list API. This API supports querying the list data of successfully published products. The API can return up to 50000 data entries at a time. If the number of products published by the merchant exceeds 50000, please increase the time range for querying. Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001239",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number, default: 1"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size, default: 50"
              },
              "insertTimeEnd": {
                "type": "string",
                "description": "End time of the product listing (when the product is first approved) Example: 2024-11-15 19:00:00"
              },
              "insertTimeStart": {
                "type": "string",
                "description": "Start time of the product listing (when the product is first approved) Example: 2024-11-15 20:00:00"
              },
              "updateTimeEnd": {
                "type": "string",
                "description": "End time of the product update (Update range includes not only product information changes but also internal system update time). Example: 2024-11-15 19:00:00"
              },
              "updateTimeStart": {
                "type": "string",
                "description": "Start time of the product update (Update range includes not only product information changes but also internal system update time). Example: 2024-11-15 19:00:00"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/modify-skc-shelf": {
      "id": 3001939,
      "method": "POST",
      "path": "/open-api/goods/modify-skc-shelf",
      "risk": "H",
      "description": "Product listed and product pending listed. This API supports modifying the product listing/delisting status based on SKC dimensions. Applicable application modes: 1, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001939",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skc_site_info_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "shelf_state": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Putaway and Picking operations; 1. Putaway, 2. Picking Important: Before initiating a Picking operation, please confirm via the interface whether the SKC can currently be picked (products participating in marketing activities may not be eligible for picking): /open-api/goods/searchProduct, activityLockList-shelfLockType"
                    },
                    "site_list": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "description": "Product site to be modified"
                      },
                      "description": "Product site to be modified"
                    },
                    "skc_name": {
                      "type": "string",
                      "description": "skc_name, skc_name is the system code generated by SHEIN for product release"
                    }
                  },
                  "required": [
                    "shelf_state",
                    "site_list",
                    "skc_name"
                  ],
                  "additionalProperties": false,
                  "description": "Listing and delisting site information, a single call supports up to 100 data records。 Important： For operations on 【same SKC+same site】, the interval must be more than 20 minutes, otherwise the operation will fail。Please do not initiate operations on the same data at a high frequency。"
                },
                "description": "Listing and delisting site information, a single call supports up to 100 data records。 Important： For operations on 【same SKC+same site】, the interval must be more than 20 minutes, otherwise the operation will fail。Please do not initiate operations on the same data at a high frequency。"
              }
            },
            "required": [
              "skc_site_info_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/spu-info": {
      "id": 3002017,
      "method": "POST",
      "path": "/open-api/goods/spu-info",
      "risk": "R",
      "description": "SPU product details query. Supports querying product information by SPU. Only SPUs that have been published and approved by the platform can be queried. Queryable information: Brand, name, image, attributes, listing status, price, and sample information at the SPU/SKC/SKU level. Unqueried information: Product inventory and attribute sorting. Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002017",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "languageList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Language list. Refers to which language information will be returned for product name, product description, and attribute name. It is recommended to input the merchant's default language to ensure valid data can be obtained. The default language can be obtained through Product Release Specifications . A maximum of 5 languages can be provided, supported languages include: English:en, French:fr, Spanish:es, German:de, Simplified Chinese:zh-cn, Thai:th, Brazilian Portuguese:pt-br, Japanese:ja, Korean:ko"
                },
                "description": "Language list. Refers to which language information will be returned for product name, product description, and attribute name. It is recommended to input the merchant's default language to ensure valid data can be obtained. The default language can be obtained through Product Release Specifications . A maximum of 5 languages can be provided, supported languages include: English:en, French:fr, Spanish:es, German:de, Simplified Chinese:zh-cn, Thai:th, Brazilian Portuguese:pt-br, Japanese:ja, Korean:ko"
              },
              "spuName": {
                "type": "string",
                "description": "Platform-generated unique code。It will be returned when the product is published or can be obtained through the Product List interface。 Only SPUs that are published and approved by the platform can have information queried。"
              }
            },
            "required": [
              "languageList",
              "spuName"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/openapi-business-backend/product/full-detail": {
      "id": 3001085,
      "method": "POST",
      "path": "/open-api/openapi-business-backend/product/full-detail",
      "risk": "R",
      "description": "sku item details query (to be deprecated soon). This API supports querying SKU details through skucode. This interface is currently suspended. Please connect to the SPU product details query (new) interface. If you need to query inventory, please connect to the inventory query interface . Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001085",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skuCodes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "skucode, supports up to 100, skucode is the system code generated by SHEIN"
                },
                "description": "skucode, supports up to 100, skucode is the system code generated by SHEIN"
              },
              "language": {
                "type": "string",
                "description": "Language, Default Chinese: zh-cn Supported Languages: English:en French:fr Spanish:es German:de Chinese:zh-cn Thai:th Brazilian Portuguese:pt-br"
              }
            },
            "required": [
              "skuCodes"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/query-publish-fill-in-standard": {
      "id": 3002044,
      "method": "POST",
      "path": "/open-api/goods/query-publish-fill-in-standard",
      "risk": "R",
      "description": "Product listing field specifications. Each store has different product listing field filling specifications (requirements) under different categories. It is recommended to call this interface before calling the product listing interface. The requirements that this interface can query include: 1. Required default language for product title and product description (default_language) 2. Whether competitor links and proof of stock are required when listing products (reference_product_link and proof_of_stock) 3. Whether sample information is required when listing products (sample_info) 4. Whether brand is required when listing products (brand_code) 5. Whether SKC title is required when listing products (skc_title) 6. Currency of supply price for semi-managed and fully managed products 7. Whether the product supports SKC Images at the u and spu dimensions (picture_config_list) 8. Is the minimum stock quantity mandatory when publishing a product? (minimum_stock_quantity) 9. Does the product support uploading detail images? (product_detail_picture) 10. Does the product support uploading the quantity of items at the SKU level? (quantity_info) 11. Does the product support uploading the SKC suggested retail price? (suggest_price) 12. Does the product support filling in the merchant barcode? (supplier_barcode) 13. Does the product support filling in the SKU packaging type? (package_type) 14. Does the product support uploading IP information? (ip_character) 15. Does the product support uploading videos? (product_video) Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002044",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "category_id": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "末级分类id。查询以下信息的填写规范时需要入参末级分类ID: 分类是否支持SPU维度图片、样品信息、SKU包装类型、SKU维度件数、站点详情图、标题默认语种的最大字符数、分类下SKU图是否必传"
              },
              "spu_name": {
                "type": "string",
                "description": "SKC code generated by SHEIN。This input parameter is only used to check whether a specific SPU is currently using the new image scheme, other scenarios do not need to be passed; usage is rare。"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/query-category-tree": {
      "id": 3001594,
      "method": "POST",
      "path": "/open-api/goods/query-category-tree",
      "risk": "R",
      "description": "Get the final category. This API supports querying the lowest-level category information of products in a store. The categories may differ between stores. Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001594",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/image-category-suggestion": {
      "id": 3001363,
      "method": "POST",
      "path": "/open-api/goods/image-category-suggestion",
      "risk": "R",
      "description": "Image and text recognition recommended category. Supports obtaining recommended categories through product images or product text descriptions, only returning recommended categories within the available categories of the current merchant. Three input combinations are possible: image only, text only, image + text. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001363",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "url": {
                "type": "string",
                "description": "Image URL. External image addresses can be used, only JPG/JPEG/PNG formats are supported, size ≤3MB. url, productInfo, one of these values must be input, or both can be input."
              },
              "productInfo": {
                "type": "string",
                "description": "Product copy information. You can input any product-related text information such as product descriptions or product names, in any language, within 1000 characters, emojis are not supported. url, productInfo, one of these values must be input, or both can be input."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/query-attribute-template": {
      "id": 3001927,
      "method": "POST",
      "path": "/open-api/goods/query-attribute-template",
      "risk": "R",
      "description": "Query available category attributes. Supports querying available attributes for a store. Different stores on the platform have different available attributes under different categories, so it is recommended to update data by store. Also, because platform rules may change, such as adding sales attributes or modifying whether attributes are mandatory, it is recommended to update weekly. Attributes include: product attributes, primary sales attributes (SKC), secondary sales attributes (SKU), and size chart attributes. Attribute rules are complex; please refer to SHEIN Product Attribute Introduction for detailed integration methods. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001927",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "product_type_id_list": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Type id collection, supports up to 10 type ids in a single call"
                },
                "description": "Type id collection, supports up to 10 type ids in a single call"
              }
            },
            "required": [
              "product_type_id_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/get-custom-attribute-permission-config": {
      "id": 3001369,
      "method": "POST",
      "path": "/open-api/goods/get-custom-attribute-permission-config",
      "risk": "R",
      "description": "Query whether custom attribute values are supported. Queries whether a certain category can customize the attribute values of sales attributes. Note: Not all merchants and all categories can customize attribute values. Before creating custom attribute values, be sure to query this interface to determine whether the Y category of merchant X can customize attribute values. Applicable application modes: 1, 2, 3, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001369",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "category_id_list": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Last-level category ID, supports up to 200"
                },
                "description": "Last-level category ID, supports up to 200"
              }
            },
            "required": [
              "category_id_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/add-custom-attribute-value": {
      "id": 3001483,
      "method": "POST",
      "path": "/open-api/goods/add-custom-attribute-value",
      "risk": "W",
      "description": "Add custom attribute values. Applications created before December 1, 2025 can use this interface. First, confirm whether the attribute supports adding custom attribute values (confirm via interface ). Then you can add custom attribute values through this interface. Alternatively, you can migrate to the new solution: Click to view Applications created after December 1, 2025, should use the product publishing and editing interface to create custom attributes. For detailed usage instructions, please refer to the documentation: Click to view Applicable application modes: not specified by this public reference; provider permission is authoritative. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001483",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "attribute_id": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Attribute ID。 Under which attribute to add the custom attribute value。"
              },
              "attribute_value": {
                "type": "string",
                "description": "Custom attribute value. Up to 100 characters, special symbols must use half-width, full-width symbols are not supported。"
              },
              "category_id": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Sub-category ID"
              },
              "attribute_value_name_multis": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "language": {
                      "type": "string",
                      "description": "Language"
                    },
                    "attribute_value_name_multi": {
                      "type": "string",
                      "description": "Custom attribute value (multilingual)。Up to 100 characters, special symbols must use half-width, full-width symbols are not supported。"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "Multilingual for custom attribute value"
                },
                "description": "Multilingual for custom attribute value"
              }
            },
            "required": [
              "attribute_id",
              "attribute_value",
              "category_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/get-associated-attribute-rules": {
      "id": 3001680,
      "method": "POST",
      "path": "/open-api/goods/get-associated-attribute-rules",
      "risk": "R",
      "description": "Query associated attribute filling rules. When publishing or editing a product, whether a product attribute (attribute_type=3/4) or size attribute (attribute_type=2) is required depends on two levels of rules: basic rules and related rules. Basic rules: Attributes are retrieved via /open-api/goods/query-attribute-template; attribute_status=3 indicates the attribute is required. Related rules: Based on the basic rules, some non-required attributes may become required due to business requirements. Rule 1: Selecting attribute A1 of attribute A makes attribute B mandatory (attribute B may originally be optional). Rule 2: Selecting attribute A1 of attribute A and attribute B1 of attribute B makes attribute C mandatory, and there may be a range of mandatory attribute values C1, C2, and C3 (attribute C may originally be optional). This API can query association rules. It is **recommended to call this API before product publishing, using all entered product attributes and attribute values as input parameters to check for any required associated attributes.** (Do not enter sales or size attributes.) Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001680",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "get_linked_rule_req_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "group_id": {
                      "type": "string",
                      "description": "Group ID, can be a developer-defined value, used for positioning in batch product queries, supports up to 10 groups in a single request."
                    },
                    "category_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Product final category id"
                    },
                    "product_type_id": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Type id corresponding to the product final category"
                    },
                    "attribute_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "attribute_id": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Attribute name id"
                          },
                          "attribute_value_id": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Attribute value id; if there are multiple attribute values under the attribute name, multiple sets of information need to be provided. When the input method of the attribute value attribute_mode=4 (dropdown selection+manual input), input the value id of the dropdown selection here, manual input attribute_extra_value does not need to be entered"
                          }
                        },
                        "required": [
                          "attribute_id"
                        ],
                        "additionalProperties": false,
                        "description": "List of filled product attributes. There is no limit to the number of attribute_id in the list."
                      },
                      "description": "List of filled product attributes. There is no limit to the number of attribute_id in the list."
                    }
                  },
                  "required": [
                    "category_id",
                    "product_type_id",
                    "attribute_list"
                  ],
                  "additionalProperties": false,
                  "description": "Enter all filled product attributes (excluding sales and size attributes), the API will return which associated attributes are mandatory under these attribute combinations. Supports querying associated attribute rules for multiple products simultaneously, with each product's information treated as a group. For example, to query the associated rules of product A and product B simultaneously, A's information is queried as group1, and B's information as group2."
                },
                "description": "Enter all filled product attributes (excluding sales and size attributes), the API will return which associated attributes are mandatory under these attribute combinations. Supports querying associated attribute rules for multiple products simultaneously, with each product's information treated as a group. For example, to query the associated rules of product A and product B simultaneously, A's information is queried as group1, and B's information as group2."
              }
            },
            "required": [
              "get_linked_rule_req_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/query-site-list": {
      "id": 3001249,
      "method": "POST",
      "path": "/open-api/goods/query-site-list",
      "risk": "R",
      "description": "Query store site and currency information (new). This API supports querying the site and currency information sold by the store Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001249",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/openapi-business-backend/site/query": {
      "id": 3001254,
      "method": "POST",
      "path": "/open-api/openapi-business-backend/site/query",
      "risk": "R",
      "description": "Query store site and site currencies (old). This API supports querying the sites and currency information sold by the store. It will no longer be updated or maintained. It is recommended to connect to Query store sites and currency information (new) . Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001254",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page num"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page size"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/query-brand-list": {
      "id": 3001900,
      "method": "POST",
      "path": "/open-api/goods/query-brand-list",
      "risk": "R",
      "description": "Query available brand list. This API supports querying available brand information for a store. Store brands may change, so please update regularly. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001900",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/query-ip-list": {
      "id": 3001901,
      "method": "POST",
      "path": "/open-api/goods/query-ip-list",
      "risk": "R",
      "description": "Query available IP list. Retrieves available IP data for the store. This data can be used in the \"ip_character_list\" parameter of the product publishing interface. IP refers to the Mickey Mouse IP image; this data is only used when the product involves IP (e.g., a collaboration). Merchants must provide authorization documents before using the available IPs. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001901",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Number per page, the maximum number per page is 200"
              },
              "idMax": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "The largest id returned in the last query result, idMax. Please enter 0 for the first query."
              }
            },
            "required": [
              "pageSize",
              "idMax"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/transform-pic": {
      "id": 3001360,
      "method": "POST",
      "path": "/open-api/goods/transform-pic",
      "risk": "W",
      "description": "Convert image link. Support converting external image addresses into SHEIN-usable image addresses， Each type of image must meet the requirements below, otherwise, it cannot be converted. Developers are advised to process the images locally before calling the API 。 - Main image (type=1)、Detail image (type=2)：Resolution of 1340px*1785px, or aspect ratio of 1:1, pixel range of 900px-2200px；Format JPG/JPEG/PNG；Size ≤3MB - Square image (type=5)：Aspect ratio of 1:1；Pixel range of 900*900~2200*2200 px；Format JPG/JPEG/PNG；Size ≤3MB - Color block image (type=6)：Aspect ratio of 1:1；Resolution of 80×80 px；Format JPG/JPEG/PNG；Size ≤3MB - Detail image (type=7)：Aspect ratio of 3:4，Resolution greater than 900px；Format JPG/JPEG/PNG；Size ≤3MB For each store category, what types of images need to be uploaded and how many images can be uploaded can be confirmed through the document： Product Images 。 Applicable application modes: 1, 2, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001360",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "image_type": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Image type (1: Main image; 2: Detail image; 5: Square image; 6: Color block image; 7: Detail page image). Refer to the description at the top of the document for the requirements of each image type."
              },
              "original_url": {
                "type": "string",
                "description": "Image address."
              }
            },
            "required": [
              "image_type",
              "original_url"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/upload-pic": {
      "id": 3001359,
      "method": "POST",
      "path": "/open-api/goods/upload-pic",
      "risk": "W",
      "description": "Local Image Upload. Support for converting image files into SHEIN-usable online image links. Each type of image must meet the requirements below, otherwise, it cannot be converted. Developers are advised to process the images locally before calling the interface . - Main image (type=1), detail image (type=2): resolution of 1340px*1785px or aspect ratio of 1:1, pixel range of 900px-2200px; format JPG/JPEG/PNG; size ≤3MB - Square image (type=5): aspect ratio of 1:1; pixel range of 900*900~2200*2200 px; format JPG/JPEG/PNG; size ≤3MB - Color block image (type=6): aspect ratio of 1:1; resolution of 80×80 px; format JPG/JPEG/PNG; size ≤3MB - Detail image (type=7): aspect ratio of 3:4, resolution greater than 900px; format JPG/JPEG/PNG; size ≤3MB For each store category, what types of images need to be uploaded and how many can be uploaded can be confirmed in the documentation: Product Images . Applicable application modes: 1, 2, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001359",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "image_type": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Image type (1: main image; 2: detail image; 5: block image; 6: color block image; 7: detail image) Refer to the description at the top of the document for the requirements of each type of image."
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
                "description": "Image File"
              }
            },
            "required": [
              "image_type",
              "file"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": true
    },
    "POST /open-api/goods/product/create-video-transform-task": {
      "id": 3002020,
      "method": "POST",
      "path": "/open-api/goods/product/create-video-transform-task",
      "risk": "W",
      "description": "Create product video conversion task. The order of calling product videos: ① Query specifications to confirm whether videos can be published under the category → ② Create video conversion task → ③ Listen for task completion notification → ④ Query task to get the converted URL → ⑤ <a [Link to API documentation: https://open.sheincorp.com/documents/apidoc/detail/3001514](https://open.sheincorp.com/documents/system/16a63f9f-7237-47bd-94c9-37059aa25554) [Link to API documentation: https://open.sheincorp.com/documents/system/16a63f9f-7237-47bd-94c9-37059aa25 ...) [Link to API documentation: https://open.sheincorp.com/documents/system/16a63f9f-7237-47bd-94c9-37059aa25554) [Link to API documentation: https://open.sheincorp.com/documents/system/16a63f9f-7237-47bd-94c9-37059aa25554](https://open.sheincorp.com/documents/system/16a63f9f-7237 Applicable application modes: 1, 2, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002020",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "video_url": {
                "type": "string",
                "description": "URL address of the video file。 Video requirements：only MP4 format is supported，maximum video size is 100M，video content does not contain sensitive information，no watermark。 URL address requirements：not a SHEIN video address，the address suffix must be .mp4，the address must be accessible and downloadable。Do not provide addresses of online video websites。Developers should pre-confirm whether the URL meets the requirements。"
              }
            },
            "required": [
              "video_url"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/product/query-video-transform-task": {
      "id": 3002021,
      "method": "POST",
      "path": "/open-api/goods/product/query-video-transform-task",
      "risk": "R",
      "description": "Get video conversion result. The order of calling product videos: ① Query specifications to confirm whether videos can be published under the category → ② Create video conversion task → ③ Listen for task completion notification → ④ Query task to get the converted URL → ⑤ Publish/Edit Products using the Transformed URL. This API is step ④ in the sequence. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002021",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "task_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "转换任务id。支持批量查询，单次最多10个任务。 通过/open-api/goods/product/create-video-transform-task获取。"
                },
                "description": "转换任务id。支持批量查询，单次最多10个任务。 通过/open-api/goods/product/create-video-transform-task获取。"
              }
            },
            "required": [
              "task_ids"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-publish-quotas/detail": {
      "id": 3002025,
      "method": "POST",
      "path": "/open-api/goods-publish-quotas/detail",
      "risk": "R",
      "description": "Query merchant publishing quota. One of the conditions for a merchant to list products is their product listing quota, which is updated monthly. The product listing quota refers to the total number of SKCs that can be successfully listed and approved within the current period. Once an SKC is approved, its listing quota cannot be restored even if it is removed or deleted. It is recommended that developers check their product listing quota (SKC dimension) before submitting product listing information. If the number of SKCs submitted exceeds the quota, the merchant should be reminded to reduce the number of SKCs. There is a \"brand exemption\" in the product listing quota management system. If a product is from a specific brand, it will not be included in the product listing quota. When listing branded products, merchants can add the brand in the input parameters to check. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002025",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "brand_code": {
                "type": "string",
                "description": "Brand code"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/query-shelf-quota": {
      "id": 3001931,
      "method": "POST",
      "path": "/open-api/goods/query-shelf-quota",
      "risk": "R",
      "description": "Obtain store listing quota. The platform controls the number of SKCs (Shop Counts) a store can list. Please check your store's available listing quota before calling the Product Listing API . Only list products if you have the quota. This listing quota is only controlled for self-operated and semi-managed merchants. Applicable application modes: 1, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001931",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "brand_code": {
                "type": "string",
                "description": "The store's available brand code can be obtained via the /open-api/goods/query-brand-list API。 For some brands of some merchants, quota exemption may be enabled, meaning the quantity of products under this brand is not controlled, so if the merchant publishes branded products, you can query by passing the code parameter。"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/product/check-supplierSku-repeated": {
      "id": 3001437,
      "method": "POST",
      "path": "/open-api/goods/product/check-supplierSku-repeated",
      "risk": "R",
      "description": "Query whether the merchant sku already exists. The platform requires that the merchant sku (i.e., supplier_sku in the release interface) of a product be globally unique within the store. It is recommended to call this function before releasing a product to check whether the merchant sku entered already exists in the store (including released products and products under review). If so, guide the merchant to change the information. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001437",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "supplierSkuList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Merchant sku。Up to 200 can be queried at a time。"
                },
                "description": "Merchant sku。Up to 200 can be queried at a time。"
              }
            },
            "required": [
              "supplierSkuList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/check-deletable": {
      "id": 3001904,
      "method": "POST",
      "path": "/open-api/goods/check-deletable",
      "risk": "R",
      "description": "Product deletion pre-validation. Product deletion is an SKC (Shop Capacity) operation. An SKC can only be deleted if it meets all of the following conditions. Points 1, 2, and 3 below can be verified through this interface. Points 4 and 5 require a deletion application to be submitted, and the final decision rests with the review results. 1. The merchant allows product deletion; not all merchants can delete products. 2. Merchants can delete a maximum of 500 SKCs per day, and there is still quota available. 3. The SKC has been approved and has not been deleted. 4. The SKC is not in the \"Listed\" status, i.e., pending listing, delisted, or sold out, before deletion. (That is, in /open-api/goods/spu-info, all sites in the SKC's shelfStatusInfoList are in a non-listed status.) 5. The SKC has no undelivered orders, returned orders, or orders valid within the past year. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001904",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skc_name_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC name list, up to 50"
                },
                "description": "SKC name list, up to 50"
              }
            },
            "required": [
              "skc_name_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "DELETE /open-api/goods/delete/{skcName}": {
      "id": 3001905,
      "method": "DELETE",
      "path": "/open-api/goods/delete/{skcName}",
      "risk": "D",
      "description": "Submit product deletion request. Validate SKC eligibility first. This submits a deletion review; inspect deletion logs for the result. Approved deletion is irreversible. Applicable application modes: not specified by this public reference; provider permission is authoritative. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001905",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "object",
            "properties": {
              "skcName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9_-]+$"
              }
            },
            "required": [
              "skcName"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-delete-logs/search": {
      "id": 3001906,
      "method": "POST",
      "path": "/open-api/goods-delete-logs/search",
      "risk": "R",
      "description": "Query product deletion review records. You can view the review and approval records of product deletion applications initiated by merchants within the past year (deletions initiated by the platform are not included; the platform periodically deletes products that have not sold for a long time). > If the input parameter `status_list=2` (approval successful) is used, you can obtain a list of deleted SKCs. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001906",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "page_num": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number, starting from 1"
              },
              "page_size": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Items per page, max 100"
              }
            },
            "required": [
              "page_num",
              "page_size"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
              "apply_no_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Application number list, up to 10 per request。"
                },
                "description": "Application number list, up to 10 per request。"
              },
              "skc_name_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC platform code list, up to 10 per request。"
                },
                "description": "SKC platform code list, up to 10 per request。"
              },
              "skc_supplier_code_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC merchant item number list, up to 10 per request。"
                },
                "description": "SKC merchant item number list, up to 10 per request。"
              },
              "status_list": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Deletion application review status list：0-Pending review 1-Under review 2-Success 3-Failure"
                },
                "description": "Deletion application review status list：0-Pending review 1-Under review 2-Success 3-Failure"
              },
              "submit_time_end": {
                "type": "string",
                "description": "Application submission time range, end time（UTC+8），format：yyyy-MM-dd HH:mm:ss。 You can query review records for up to the past year"
              },
              "submit_time_start": {
                "type": "string",
                "description": "Application submission time range, start time (UTC+8), format: yyyy-MM-dd HH:mm:ss。 You can query up to the review records from the past year"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/get-certificate-rule": {
      "id": 3001859,
      "method": "POST",
      "path": "/open-api/goods/get-certificate-rule",
      "risk": "R",
      "description": "Check product certificate requirements and verification status. This API supports querying certificate requirements and certificate information. The open platform launched a new interface for qualification certificates in July 2026. It is recommended to connect to the new interface. For detailed solutions, please refer to the documentation at . Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001859",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "attributeList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "attributeId": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Common attribute ID of the product; attribute_type=4 attributes in the interface for communicating with the store 4 attributes"
                    },
                    "attributeValueId": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Common attribute value ID of the product; Common attribute ID of the product, attribute_type=4 values in the interface for communicating with the store 4 attribute values"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "Attribute array"
                },
                "description": "Attribute array"
              },
              "categoryId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Product's end-level category ID"
              },
              "certificatePoolId": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Certificate pool ID; obtainable by creating a certificate pool, can be used to check the current verification status of the certificate pool"
                },
                "description": "Certificate pool ID; obtainable by creating a certificate pool, can be used to check the current verification status of the certificate pool"
              },
              "siteArrList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Site information for product sales"
                },
                "description": "Site information for product sales"
              },
              "spuName": {
                "type": "string",
                "description": "SPU generated by the SHEIN platform, corresponding to the product publication's spu_name; It is recommended to use spu to query the necessary certificates for the product and the certificate review status"
              },
              "systemId": {
                "type": "string",
                "description": "Source system: Fixed transmitted spmp"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/certificate/get-all-certificate-type-list-v2": {
      "id": 3001860,
      "method": "POST",
      "path": "/open-api/goods/certificate/get-all-certificate-type-list-v2",
      "risk": "R",
      "description": "Documents required to query the certificate (New). This API supports querying all required information for certificates, allowing developers to understand the information needed to upload certificates, such as: testing organization, battery model, product model, certificate number, certificate validity period, and certificate expiration period. The open platform launched a new qualification certificate interface in July 2026. It is recommended to connect to the new interface. For detailed solutions, please refer to the documentation: Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001860",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/upload-certificate-file": {
      "id": 3001861,
      "method": "POST",
      "path": "/open-api/goods/upload-certificate-file",
      "risk": "W",
      "description": "Upload certificate file. This API supports converting local files to the online URLs required by SHEIN. In July 2026, the Open Platform launched a new qualification certificate interface. It is recommended to connect to the new interface. For detailed solutions, please refer to the documentation. Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001861",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
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
                "description": "file ; single file upload within 20MB, in PDF/PNG/JPG/JPEG format"
              }
            },
            "required": [
              "file"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": true
    },
    "POST /open-api/goods/save-or-update-certificate-pool": {
      "id": 3001862,
      "method": "POST",
      "path": "/open-api/goods/save-or-update-certificate-pool",
      "risk": "H",
      "description": "Create/edit product certificate pool. This API supports creating or editing product certificate pools. When `certificateDimension=1`, it indicates that this type of certificate needs to be bound to an SKC, therefore a product certificate pool needs to be created. In addition, after creating the product certificate pool, developers also need to call the SKC binding interface to complete the certificate upload. In July 2026, the open platform launched a new interface for qualification certificates. It is recommended to connect to the new interface. For detailed solutions, please refer to the documentation: [https://open.sheincorp.com/documents/system/05911185-74f1-48d6-a620-fdfb756f6a86](https://open.sheincorp.com/documents/system/05911185-74f1-48d6-a620-fdfb756f6a86) Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001862",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "certificatePoolId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Certificate pool id"
              },
              "certificateRelationInfoList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "certificateRelationNameId": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Related field names Testing agency/certificate number/certificate update alert time/product name/battery signal/certificate validity period etc."
                    },
                    "certificateRelationValue": {
                      "type": "string",
                      "description": "When the inputType is 3 or 4, custom values required for the certificate field should be entered in this field. Date format example: 2025-01-01 00:00:00"
                    },
                    "certificateRelationValueId": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Related field values"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "Certificate related fields mainly include: certificate number/certificate update alert time/product name/battery signal/certificate validity period etc."
                },
                "description": "Certificate related fields mainly include: certificate number/certificate update alert time/product name/battery signal/certificate validity period etc."
              },
              "certificateTypeId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Certificate type id 注意： certificateTypeId=844（Product identifier）is currently not supported for upload via API, please filter this type of certificate."
              },
              "certificateUrl": {
                "type": "string",
                "description": "Certificate file address"
              },
              "certificateUrlName": {
                "type": "string",
                "description": "Certificate file name"
              },
              "otherCertificateRelationInfoList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "certificateRelationNameId": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Related field names Testing agency/certificate number/certificate update alert time/product name/battery signal/certificate validity period etc."
                    },
                    "certificateRelationValue": {
                      "type": "string",
                      "description": "When the inputType is 3 or 4, custom values required for the certificate field should be entered in this field. Date format example: 2025-01-01 00:00:00"
                    },
                    "certificateRelationValueId": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Related field values"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "External certificate related field"
                },
                "description": "External certificate related field"
              }
            },
            "required": [
              "certificateTypeId",
              "certificateUrl",
              "certificateUrlName"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/save-or-update-supplier-certificate": {
      "id": 3001863,
      "method": "POST",
      "path": "/open-api/goods/save-or-update-supplier-certificate",
      "risk": "H",
      "description": "Create/edit shop certificate pool. This API supports creating or editing store certificate pools. When `certificateDimension=2`, it indicates that this type of certificate is a store-level certificate and does not need to be bound to an SKC product. Therefore, after creating a store certificate pool, you can complete the upload of the store certificate. In July 2026, the open platform launched a new interface for qualification certificates. It is recommended to connect to the new interface. For detailed solutions, please refer to the documentation: [https://open.sheincorp.com/documents/system/05911185-74f1-48d6-a620-fdfb756f6a86](https://open.sheincorp.com/documents/system/05911185-74f1-48d6-a620-fdfb756f6a86) Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001863",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "certificatePoolId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Certificate pool id, if passed this value then updates, if not passed default is to add new"
              },
              "certificateTypeId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Certificate type ID"
              },
              "certificateUrl": {
                "type": "string",
                "description": "Certificate file address"
              },
              "certificateUrlName": {
                "type": "string",
                "description": "Certificate file name"
              }
            },
            "required": [
              "certificateTypeId",
              "certificateUrl",
              "certificateUrlName"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "void",
      "allow_absent_result": true,
      "multipart": false
    },
    "POST /open-api/goods/save-certificate-pool-skc-bind": {
      "id": 3001864,
      "method": "POST",
      "path": "/open-api/goods/save-certificate-pool-skc-bind",
      "risk": "H",
      "description": "SKC bind product certificate pool. This API supports binding product certificate pools to products (SKC dimension). When certificateDimension=1, it means that this type of certificate needs to be bound to an SKC. Therefore, after creating a product certificate pool, this interface needs to be called to complete the certificate upload. In July 2026, the open platform launched a new interface for qualification certificates. It is recommended to connect to the new interface. For detailed solutions, please refer to the documentation: [https://open.sheincorp.com/documents/system/05911185-74f1-48d6-a620-fdfb756f6a86](https://open.sheincorp.com/documents/system/05911185-74f1-48d6-a620-fdfb756f6a86) Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001864",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skcCertificatePoolRelationList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "certificatePoolIdList": {
                      "type": "array",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991,
                        "description": "Certificate pool ID collection"
                      },
                      "description": "Certificate pool ID collection"
                    },
                    "skcName": {
                      "type": "string",
                      "description": "SKC generated by SHEIN platform, corresponding product's published skc_name"
                    },
                    "spuName": {
                      "type": "string",
                      "description": "SPU generated by SHEIN platform, corresponding product's published spu_name"
                    }
                  },
                  "required": [
                    "certificatePoolIdList",
                    "skcName",
                    "spuName"
                  ],
                  "additionalProperties": false,
                  "description": "Collection of SKC and certificate pool certificate binding relationships"
                },
                "description": "Collection of SKC and certificate pool certificate binding relationships"
              }
            },
            "required": [
              "skcCertificatePoolRelationList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "void",
      "allow_absent_result": true,
      "multipart": false
    },
    "POST /open-api/openapi-business-backend/product/price/save": {
      "id": 3001940,
      "method": "POST",
      "path": "/open-api/openapi-business-backend/product/price/save",
      "risk": "H",
      "description": "Product price update API. Prices may await review (status=2); do not submit another price change until the result is known. Omitted specialPrice resets it to zero. Applicable application modes: 1. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001940",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "productPriceList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "productCode": {
                      "type": "string",
                      "description": "transfer sku_code, sku_code is the system code generated by SHEIN for product publication"
                    },
                    "currencyCode": {
                      "type": "string",
                      "description": "Currency, the selling currency used on the SHEIN platform, such as BRL, THB, USD, MXN. For specific currencies, please refer to Store Site and Currency Information (New)"
                    },
                    "shopPrice": {
                      "type": "number",
                      "description": "Original price. Before initiating a price increase, please confirm via the API whether the product can be increased in price (products participating in marketing activities may not be eligible for price increases): /open-api/goods/searchProduct, activityLockList-priceLockType"
                    },
                    "specialPrice": {
                      "type": "number",
                      "description": "Special Price, Note: When special price is not sent, the default special price is updated to 0!"
                    },
                    "site": {
                      "type": "string",
                      "description": "Site - Can only transmit subsites. For example, shein-us"
                    },
                    "riseReason": {
                      "type": "string",
                      "description": "Reason for price increase。 Enum:1-Product cost increased,2-Logistics fulfillment cost increased,3-Price restored after event ended,4-Other,5-Logistics fulfillment cost increased（Logistics rule adjustment）"
                    }
                  },
                  "required": [
                    "productCode",
                    "currencyCode",
                    "shopPrice",
                    "site"
                  ],
                  "additionalProperties": false,
                  "description": "Item Price Information List, Max Length 100"
                },
                "description": "Item Price Information List, Max Length 100"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/update-cost": {
      "id": 3001941,
      "method": "POST",
      "path": "/open-api/goods/update-cost",
      "risk": "H",
      "description": "Update cost price. This API supports updating product cost price (also known as supply price) information. Applicable application modes: 2, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001941",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skc_info_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "skc_name": {
                      "type": "string",
                      "description": "skc_name, skc_name is the system code generated by SHEIN for product release"
                    },
                    "change_price_reason_flag": {
                      "type": "string",
                      "description": "Price increase reason code. You must enter the enumeration value provided by the platform; do not input arbitrary values. This field becomes mandatory starting July 1, 2026. The available price increase reasons vary by merchant and must be retrieved via the /open-api/goods/query-change-price-reason endpoint. Before initiating a price increase, please confirm via the endpoint whether the product is eligible for a price increase (products participating in marketing activities may be ineligible): /open-api/goods/searchProduct, activityLockList-priceLockType"
                    },
                    "change_remark": {
                      "type": "string",
                      "description": "Explanation of the reason for the price increase。Merchants can customize the input content, up to 1000 characters。"
                    },
                    "file_upload_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "object_key": {
                            "type": "string",
                            "description": "File unique code。Must be obtained via interface conversion：/open-api/goods/discuss/upload-discuss-file"
                          },
                          "type": {
                            "type": "string",
                            "description": "File type。1:image（jpg / jpeg / png） 2:pdf 5:csv 6:excel（xls / xlsx） Required，if not provided it may cause the operations side to be unable to view the materials properly, resulting in abnormal review。"
                          },
                          "url": {
                            "type": "string",
                            "description": "File URL。Must be obtained via interface conversion：/open-api/goods/discuss/upload-discuss-file"
                          }
                        },
                        "required": [
                          "object_key",
                          "type"
                        ],
                        "additionalProperties": false,
                        "description": "Supporting materials for the reason for the price increase, up to 1 material can be uploaded。"
                      },
                      "description": "Supporting materials for the reason for the price increase, up to 1 material can be uploaded。"
                    },
                    "sku_info_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "cost": {
                            "type": "number",
                            "description": "Updated cost price（supply price）。 A numeric value greater than 0 and less than 100000, up to 2 decimal places。"
                          },
                          "currency": {
                            "type": "string",
                            "description": "Currency. Needs to be obtained through Product publishing field specifications (including default languages) , field \" currency \""
                          },
                          "sku_code": {
                            "type": "string",
                            "description": "sku_code, sku_code is the system code generated by SHEIN for product release"
                          }
                        },
                        "required": [
                          "cost",
                          "currency",
                          "sku_code"
                        ],
                        "additionalProperties": false,
                        "description": "sku information。Upload up to 20 sku at a time。"
                      },
                      "description": "sku information。Upload up to 20 sku at a time。"
                    }
                  },
                  "required": [
                    "skc_name",
                    "change_price_reason_flag",
                    "sku_info_list"
                  ],
                  "additionalProperties": false,
                  "description": "skc information。Upload up to 20 skc at a time。"
                },
                "description": "skc information。Upload up to 20 skc at a time。"
              },
              "spu_name": {
                "type": "string",
                "description": "spu_name, spu_name is the system code generated by SHEIN for product release"
              }
            },
            "required": [
              "skc_info_list",
              "spu_name"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "void",
      "allow_absent_result": true,
      "multipart": false
    },
    "POST /open-api/goods/query-change-price-reason": {
      "id": 3001885,
      "method": "POST",
      "path": "/open-api/goods/query-change-price-reason",
      "risk": "R",
      "description": "Get cost price increase reason enum values. The enumeration values obtained from this interface can be used in the price increase reason (change_price_reason_flag) of the update cost price interface (/open-api/goods/update-cost). Applicable application modes: 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001885",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "skc_name": {
                      "type": "string",
                      "description": "skc platform code"
                    }
                  },
                  "required": [
                    "skc_name"
                  ],
                  "additionalProperties": false,
                  "description": "List of skc to query"
                },
                "description": "List of skc to query"
              }
            },
            "required": [
              "list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/discuss/upload-discuss-file": {
      "id": 3001886,
      "method": "POST",
      "path": "/open-api/goods/discuss/upload-discuss-file",
      "risk": "W",
      "description": "Price proof material upload. Documents required for uploading negotiation lists, updating cost prices, and SKU suggested retail prices. Applicable application modes: 1, 2, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001886",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "type": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Upload scenario。 1=bargaining form supporting materials；4=SKU suggested retail price supporting materials；5=cost price increase supporting materials。"
              }
            },
            "required": [
              "type"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "object",
            "properties": {
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
                "description": "Local file。 When type=1（bargaining form supporting materials）, only images are supported, max 10M。 When type=4（SKU suggested retail price supporting materials）, only jpg、jpeg、png、pdf are supported，，max 10M。 When type=5（cost price increase supporting materials）, uploading jpg / jpeg / png / pdf / csv / xls / xlsx is supported，max 10M。"
              }
            },
            "required": [
              "file"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query",
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": true
    },
    "POST /open-api/goods-recommend-retail-price/search": {
      "id": 3001893,
      "method": "POST",
      "path": "/open-api/goods-recommend-retail-price/search",
      "risk": "R",
      "description": "Query product suggested retail price. Query the current suggested retail price details for the product. Note: Before updating the suggested retail price, please be sure to query the current suggested retail price information for the product, because the update is a full overwrite logic. When submitting, you must provide all the required information; the original data will be cleared, and the latest updated information will prevail. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001893",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skc_name_list": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "The SKC platform code list supports querying up to 100 SKCs at a time."
                },
                "description": "The SKC platform code list supports querying up to 100 SKCs at a time."
              }
            },
            "required": [
              "skc_name_list"
            ],
            "additionalProperties": false,
            "description": "查询SKC建议零售价列表请求"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/query-recommend-retail-price-rule": {
      "id": 3002033,
      "method": "POST",
      "path": "/open-api/goods/query-recommend-retail-price-rule",
      "risk": "R",
      "description": "Query suggested retail price entry rules. Rules for entering suggested retail price (SKU dimension). Please refer to the instruction document before use: https://open.sheincorp.com/documents/system/bf5a59ca-d378-4417-a359-f07cc89bf96b Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002033",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "brand_code": {
                "type": "string",
                "description": "Brand code, for example “2xyz2”, can be obtained via the API /open-api/goods/query-brand-list。 If the product has a brand provided, you must pass the brand code as an input parameter to get the rules. The filling rules differ greatly between the two cases: with brand and without brand。"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-recommend-retail-price/batch-save": {
      "id": 3001895,
      "method": "POST",
      "path": "/open-api/goods-recommend-retail-price/batch-save",
      "risk": "H",
      "description": "Submit suggested retail price. Supports adding/updating the suggested retail price of products. After submitting an application to add/update the suggested retail price, it will enter the review process. Note: Updating the suggested retail price is a full overwrite logic. Please be sure to pass all the required information when submitting. You can check the current suggested retail price information of the product before updating; the original data will be cleared. Applicable application modes: 1, 2, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001895",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skc_rrp_list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "skc_name": {
                      "type": "string",
                      "description": "SKC platform code"
                    },
                    "sku_rrp_info_list": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "currency": {
                            "type": "string",
                            "description": "Currency"
                          },
                          "site": {
                            "type": "string",
                            "description": "Site abbreviation。 Under sub-site rules, fill in the site name. Under non-sub-site rules, you don't need to write the site"
                          },
                          "sku_code": {
                            "type": "string",
                            "description": "SKU Platform Code"
                          },
                          "suggested_retail_price": {
                            "type": "number",
                            "description": "Adjusted recommended retail price, leaving it blank indicates clearing. Different currencies have different precision requirements, for precision requirements refer to FAQ"
                          },
                          "type_one_proof": {
                            "type": "object",
                            "properties": {
                              "attachments": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "description": "Supporting material attachment list, image or PDF URL, no more than 6 materials can be uploaded。 The URL must use a SHEIN link, obtain it via the conversion API：/open-api/goods/discuss/upload-discuss-file"
                                },
                                "description": "Supporting material attachment list, image or PDF URL, no more than 6 materials can be uploaded。 The URL must use a SHEIN link, obtain it via the conversion API：/open-api/goods/discuss/upload-discuss-file"
                              },
                              "proof_link": {
                                "type": "string",
                                "description": "Website address, no more than 1000 characters"
                              }
                            },
                            "required": [],
                            "additionalProperties": false,
                            "description": "Type 1 supporting materials"
                          },
                          "type_two_proof": {
                            "type": "object",
                            "properties": {
                              "attachments": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "description": "Supporting material attachment list, image or PDF URL, no more than 6 materials can be uploaded。 The URL must use a SHEIN link, obtain it via the conversion API：/open-api/goods/discuss/upload-discuss-file"
                                },
                                "description": "Supporting material attachment list, image or PDF URL, no more than 6 materials can be uploaded。 The URL must use a SHEIN link, obtain it via the conversion API：/open-api/goods/discuss/upload-discuss-file"
                              },
                              "proof_link": {
                                "type": "string",
                                "description": "Website address, no more than 1000 characters"
                              }
                            },
                            "required": [],
                            "additionalProperties": false,
                            "description": "类型二证明材料"
                          }
                        },
                        "required": [
                          "currency",
                          "sku_code"
                        ],
                        "additionalProperties": false,
                        "description": "SKU information list."
                      },
                      "description": "SKU information list."
                    },
                    "spu_name": {
                      "type": "string",
                      "description": "SPU Platform Code"
                    }
                  },
                  "required": [
                    "skc_name",
                    "sku_rrp_info_list"
                  ],
                  "additionalProperties": false,
                  "description": "SKC information list。Up to 10 SKCs can be submitted at the same time per submission。 Before submitting, please query the recommended retail price filling rules for the SKC：/open-api/goods/query-recommend-retail-price-rule For detailed instructions on the recommended retail price, refer to the document： https://open.sheincorp.com/documents/system/bf5a59ca-d378-4417-a359-f07cc89bf96b"
                },
                "description": "SKC information list。Up to 10 SKCs can be submitted at the same time per submission。 Before submitting, please query the recommended retail price filling rules for the SKC：/open-api/goods/query-recommend-retail-price-rule For detailed instructions on the recommended retail price, refer to the document： https://open.sheincorp.com/documents/system/bf5a59ca-d378-4417-a359-f07cc89bf96b"
              }
            },
            "required": [
              "skc_rrp_list"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-recommend-retail-price-audit/search": {
      "id": 3001890,
      "method": "POST",
      "path": "/open-api/goods-recommend-retail-price-audit/search",
      "risk": "R",
      "description": "Query suggested retail price review records. Detailed review record of suggested retail price. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001890",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "audit_state_list": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Review status list。1: Pending review 2: Review successful 3: Review failed 5: Partially approved 6: Withdrawn 5: Partially approved indicates that some SKUs under the SKC have passed the review and obtained a validity period。"
                },
                "description": "Review status list。1: Pending review 2: Review successful 3: Review failed 5: Partially approved 6: Withdrawn 5: Partially approved indicates that some SKUs under the SKC have passed the review and obtained a validity period。"
              },
              "page_num": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page Number"
              },
              "page_size": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page size, maximum 100 per page"
              },
              "skc": {
                "type": "string",
                "description": "SKC platform code"
              },
              "spu": {
                "type": "string",
                "description": "SPU Platform Code"
              }
            },
            "required": [
              "page_num",
              "page_size"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/discuss/query-discuss-list": {
      "id": 3001891,
      "method": "POST",
      "path": "/open-api/goods/discuss/query-discuss-list",
      "risk": "R",
      "description": "Get the list of discuss prices. Supports obtaining a list of negotiation orders for product cost prices. Currently, only 3 negotiation types are supported: New Product Negotiation, Existing Product Negotiation, and New Product Price Review and Reconsideration. Applicable application modes: 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001891",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "discussStatus": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Bargaining order status,。 1:Pending merchant confirmation 2:Pending platform review 3:Accept bargaining 4:Do not accept bargaining 5:Bargaining terminated-Successful 6:Bargaining terminated-Failed"
              },
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Number of pages. It is recommended to start querying from 1"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Number of items per page, up to 200 per page"
              }
            },
            "required": [
              "pageNum",
              "pageSize"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/discuss/process-discuss": {
      "id": 3001892,
      "method": "POST",
      "path": "/open-api/goods/discuss/process-discuss",
      "risk": "H",
      "description": "Process discuss order. Only negotiation orders with a status of discussStatus=1 (pending merchant confirmation) can use this API call for processing. There are three processing operations for negotiation orders. 1. Agree to the platform's suggested price: After agreeing, the product price will be changed to the platform's suggested price, and the negotiation order will end. 2. Reject and abandon listing the product: After rejection, the negotiation order ends, the merchant can no longer initiate quotation processing, and the product cannot be listed. 3. Requote: If the merchant has questions about the platform's suggested price, they can communicate the price again. Applicable application modes: 2, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001892",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "confirmInfos": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "discussAuditType": {
                      "type": "string",
                      "description": "Operation type 1-Agree to the platform's suggested price； 2-Reject, give up listing"
                    },
                    "discussSn": {
                      "type": "string",
                      "description": "Bargaining order number Only bargaining orders with discussStatus=1 (pending merchant confirmation) can use this interface call for processing。"
                    }
                  },
                  "required": [
                    "discussAuditType",
                    "discussSn"
                  ],
                  "additionalProperties": false,
                  "description": "When the bargaining order operation=【Agree to the platform's suggested price】or【Reject, give up listing】, please input parameters in this field。 Note：Each bargaining order can only execute one operation, do not input parameters in confirmInfos、createCostDiscusses to execute multiple operations at the same time。"
                },
                "description": "When the bargaining order operation=【Agree to the platform's suggested price】or【Reject, give up listing】, please input parameters in this field。 Note：Each bargaining order can only execute one operation, do not input parameters in confirmInfos、createCostDiscusses to execute multiple operations at the same time。"
              },
              "createCostDiscusses": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "discussSn": {
                      "type": "string",
                      "description": "Bargaining number。 Only bargaining orders with discussStatus=1 (awaiting merchant confirmation) can use this interface call."
                    },
                    "discussStep": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Number of rounds for the bargaining order。The number of times each bargaining order can communicate the price is limited, if the number=0, it means that a new quotation cannot be initiated again。 Value logic=Obtain the bargaining order list interface：/open-api/goods/discuss/query-discuss-list's serialNumber"
                    },
                    "fileUploadList": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "file_name": {
                            "type": "string",
                            "description": "Original file name (maintained by developer)"
                          },
                          "object_key": {
                            "type": "string",
                            "description": "File key, generated by the platform, obtained after uploading the file through the interface /open-api/goods/discuss/upload-discuss-file"
                          },
                          "type": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "File type. Only 1:Image is supported"
                          },
                          "url": {
                            "type": "string",
                            "description": "File url, generated by the platform, obtained after uploading the file through the interface /open-api/goods/discuss/upload-discuss-file"
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "Upload negotiation materials"
                      },
                      "description": "Upload negotiation materials"
                    },
                    "reason": {
                      "type": "string",
                      "description": "The seller fills in the reason for initiating the bargaining, up to 255 characters"
                    },
                    "skcName": {
                      "type": "string",
                      "description": "Platform's skc code"
                    },
                    "skuCostInfoList": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "cost": {
                            "type": "number",
                            "description": "Cost price"
                          },
                          "currency": {
                            "type": "string",
                            "description": "Currency"
                          },
                          "lastCost": {
                            "type": "number",
                            "description": "The cost price of the last quotation. Value logic= Query the bargaining list API: /open-api/goods/discuss/query-discuss-list, in the response under \"costPriceHistories\", the cost price of the group with the largest \"serialNumber\" value (i.e., the price during the latest bargaining in the bargaining history. Note: SKUs that have never been bargained also have a bargaining history, and the price set when the product was published will be used as the first bargaining history.)"
                          },
                          "lastCurrency": {
                            "type": "string",
                            "description": "The currency of the last quotation. Value logic= Query the bargaining list API: /open-api/goods/discuss/query-discuss-list, in the response under \"costPriceHistories\", the currency of the group with the largest \"serialNumber\" value"
                          },
                          "skuCode": {
                            "type": "string",
                            "description": "The platform's SKU code"
                          }
                        },
                        "required": [
                          "cost",
                          "currency",
                          "lastCost",
                          "lastCurrency",
                          "skuCode"
                        ],
                        "additionalProperties": false,
                        "description": "The list of SKU cost prices for initiating a bargain"
                      },
                      "description": "The list of SKU cost prices for initiating a bargain"
                    }
                  },
                  "required": [
                    "discussSn",
                    "discussStep",
                    "skcName",
                    "skuCostInfoList"
                  ],
                  "additionalProperties": false,
                  "description": "When the bargaining order operation=【Requote】, please input parameters in this field。 Note：Each bargaining order can only execute one operation, do not input parameters in confirmInfos、createCostDiscusses to execute multiple operations at the same time。"
                },
                "description": "When the bargaining order operation=【Requote】, please input parameters in this field。 Note：Each bargaining order can only execute one operation, do not input parameters in confirmInfos、createCostDiscusses to execute multiple operations at the same time。"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-compliance-requirements/list": {
      "id": 3001849,
      "method": "POST",
      "path": "/open-api/goods-compliance-requirements/list",
      "risk": "R",
      "description": "Query SKC compliance information requirements. The platform allows you to query the compliance information binding requirements for SKC (including qualification certificates, agent companies, warning statements, compliance laws, selling points, and instruction manuals). The output data corresponds to the product compliance management list in the merchant's backend. For a complete compliance information solution, please refer to the documentation at . 【Important Notes】 The complianceGroupCode field in the output parameters can be used to distinguish the type of compliance information. Currently, the open platform does not support the creation of all compliance information types, and the calling interfaces for different compliance types are also different. Please read the enumeration instructions below. ZSZZL: Certificate and qualification type, such as various test reports, can be created via API. First, query the fill-in rules /open-api/goods-certificate-schemas/detail, then create /open-api/goods-certificates/save. GSL: Company type, such as agency companies, can be created via API. First, query the company list /open-api/goods-compliance/agency-list, then bind it to SKC /open-api/goods-compliance/save-skc-agency. HGXXL: Compliance information type, such as product identifiers and warnings. Only manually bound warnings in this category can currently be created via API, determined by isManualProductWarning=true. First, query the fill-in rules /open-api/goods-compliance/query-warning-certificate-rules, then edit the SKC warning message /open-api/goods-compliance/update-skc-warning-certificate. Other information is not currently supported for creation via API. SPTL: Point-of-Sale certificates, not currently supported for creation via API. SPSMS: Instructions; creation via API is not currently supported. Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001849",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "certificateTypeCodes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Certificate type code list, up to 20"
                },
                "description": "Certificate type code list, up to 20"
              },
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page number"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page Size, Maximum 200"
              },
              "reviewStates": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Review status。0=Not reviewed（i.e., currently missing）;1=Pending review;2=Review successful;3=Review rejected"
                },
                "description": "Review status。0=Not reviewed（i.e., currently missing）;1=Pending review;2=Review successful;3=Review rejected"
              },
              "skcNames": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC code list, up to 200"
                },
                "description": "SKC code list, up to 200"
              }
            },
            "required": [
              "pageNum",
              "pageSize"
            ],
            "additionalProperties": false,
            "description": "Request to query the SKC product warning statement binding list"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-certificates/search": {
      "id": 3001907,
      "method": "POST",
      "path": "/open-api/goods-certificates/search",
      "risk": "R",
      "description": "Query qualification certificate list. Retrieve the list of existing qualification certificates created within the store (corresponding to the Merchant Backend - Compliance - Product Compliance Management - Certificate Store tab list). For complete API call instructions for qualification certificate scenarios, see the documentation Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001907",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "certificateTypeCodeList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Certificate type code list, up to 10 per query."
                },
                "description": "Certificate type code list, up to 10 per query."
              },
              "fileName": {
                "type": "string",
                "description": "Certificate file name (i.e., the name of the image or pdf file in the certificate), fuzzy search"
              },
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number, starting from 1"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page size, maximum 100。"
              },
              "poolSnList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Certificate number list（i.e., the platform's unique code for each certificate）"
                },
                "description": "Certificate number list（i.e., the platform's unique code for each certificate）"
              },
              "statusList": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Certificate status list：1-pending effective，2-effective，3-expired，4-pending completion，5-about to expire，6-draft。"
                },
                "description": "Certificate status list：1-pending effective，2-effective，3-expired，4-pending completion，5-about to expire，6-draft。"
              }
            },
            "required": [
              "pageNum",
              "pageSize"
            ],
            "additionalProperties": false,
            "description": "ERP certificate pool list query request"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-certificate-schemas/detail": {
      "id": 3002037,
      "method": "POST",
      "path": "/open-api/goods-certificate-schemas/detail",
      "risk": "R",
      "description": "Query qualification certificate filling rules. The rules for obtaining qualification certificates only support obtaining the rules for complianceGroupCode= ZSZZL . Rules for obtaining other compliance information can be obtained through other interfaces. A complete solution for calling the qualification certificate interface is available here: [link to document]. See the documentation for details. Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002037",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "certificateTypeCodes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Certificate type code, up to 10 can be queried at a time。"
                },
                "description": "Certificate type code, up to 10 can be queried at a time。"
              },
              "certificateTypeIdList": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Certificate type id, maximum batch query quantity:1000"
                },
                "description": "Certificate type id, maximum batch query quantity:1000"
              }
            },
            "required": [],
            "additionalProperties": false,
            "description": "ERP batch query certificate basic data configuration request"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-certificate-files/upload": {
      "id": 3001852,
      "method": "POST",
      "path": "/open-api/goods-certificate-files/upload",
      "risk": "W",
      "description": "Upload qualification certificate file. This can convert local files into SHEIN file links, used to create/update file content in qualification certificates. For complete qualification certificate retrieval solutions, see the documentation at . Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001852",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
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
                "description": "file；single file upload within 20M, in PDF/PNG/JPG/JPEG format"
              }
            },
            "required": [
              "file"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": true
    },
    "POST /open-api/goods-certificates/save": {
      "id": 3001908,
      "method": "POST",
      "path": "/open-api/goods-certificates/save",
      "risk": "H",
      "description": "Create/Edit qualification certificate. You can create and edit qualification certificates. Before proceeding, please refer to the certificate entry rules (/open-api/goods-certificate-schemas/detail) and operate accordingly. For the complete qualification certificate API call solution, see the documentation. Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001908",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "certificateDimension": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Certificate applicable scope：1-部分商品（i.e., needs to be manually bound to products），2-全部商品（i.e., automatically bound to all products）。 Required when creating。"
              },
              "certificateTypeCode": {
                "type": "string",
                "description": "Certificate type code。Required when creating, can be obtained via /open-api/goods-compliance-requirements/list。"
              },
              "fileList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "fileMd5": {
                      "type": "string",
                      "description": "File MD5。Obtain via the upload API：/open-api/goods-certificate-files/upload"
                    },
                    "fileName": {
                      "type": "string",
                      "description": "File name。ERP custom name。"
                    },
                    "fileUrl": {
                      "type": "string",
                      "description": "File URL。Obtain via the upload API：/open-api/goods-certificate-files/upload"
                    }
                  },
                  "required": [
                    "fileMd5",
                    "fileName",
                    "fileUrl"
                  ],
                  "additionalProperties": false,
                  "description": "Certificate file list。 All files must be converted to SHEIN links before uploading, external url is not supported。Upload API：/open-api/goods-certificate-files/upload"
                },
                "description": "Certificate file list。 All files must be converted to SHEIN links before uploading, external url is not supported。Upload API：/open-api/goods-certificate-files/upload"
              },
              "poolSn": {
                "type": "string",
                "description": "Certificate number。No need to fill in when creating, must be filled in when editing。"
              },
              "presetInfoList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "presetId": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Field id. Obtained from /open-api/goods-certificate-schemas/detail. otherPresetInfoList and in presetInfoList all presetId are passed into this field."
                    },
                    "valueList": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "value": {
                            "type": "string",
                            "description": "Field Value (Manually Entered Value) 1. For fields under presetInfoList, when inputType=3/4, enter the manually entered value. 2. For fields under otherPresetInfoList, there are two scenarios: 2.1 If sourceFrom=SRM, enter the laboratory ID (srmDetectionAgencyList-laboratoryId). The laboratory and the organization of valueId must be in the same data group.) 2.2 If sourceFrom≠SRM, enter the field's own value (otherPresetInfoList - presetValueList-presetValue)."
                          },
                          "valueId": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "字段值（填写id） 1、presetInfoList下字段，当inputType=1/2时，录入id（ presetInfoList- presetValueList- presetValueId ） 2、otherPresetInfoList下字段，有两种情况： 2.1 sourceFrom=SRM，需输入机构id（srmDetectionAgencyList-detectionAgencyId。机构需和value的实验室在同组数据内） 2.2 sourceFrom≠SRM，输入字段自己的valueId（otherPresetInfoList-presetValueList-presetValueId）"
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "Field value list。"
                      },
                      "description": "Field value list。"
                    }
                  },
                  "required": [
                    "presetId",
                    "valueList"
                  ],
                  "additionalProperties": false,
                  "description": "Certificate field list"
                },
                "description": "Certificate field list"
              }
            },
            "required": [],
            "additionalProperties": false,
            "description": "ERP save certificate pool request"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-certificates/bind": {
      "id": 3001854,
      "method": "POST",
      "path": "/open-api/goods-certificates/bind",
      "risk": "H",
      "description": "SKC bind qualification certificate. Product binding qualification certificate. For the complete qualification certificate interface solution, see the documentation for details. Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001854",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "poolSn": {
                "type": "string",
                "description": "Qualification certificate pool number. There are two ways to obtain it： 1、Get the poolSn of all qualification certificates in the store via API /open-api/goods-certificates/search. 2、The poolSn returned in the response body after creating a qualification certificate."
              },
              "skcNames": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "List of SKCs to be bound, using the platform code, up to 200 at a time。"
                },
                "description": "List of SKCs to be bound, using the platform code, up to 200 at a time。"
              }
            },
            "required": [
              "poolSn",
              "skcNames"
            ],
            "additionalProperties": false,
            "description": "ERP SKC bind certificate pool request"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "string",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-compliance/agency-list": {
      "id": 3001848,
      "method": "POST",
      "path": "/open-api/goods-compliance/agency-list",
      "risk": "R",
      "description": "Query agency company list. Query the information of the agent companies declared by the merchant, including the EU responsible person, manufacturer, US agent, and UK agent. The information returned by this interface will be used when SKC binds the agent company. For the overall solution of the agent company, click to view the document. Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001848",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "agencyId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Agent company ID"
              },
              "agencyName": {
                "type": "string",
                "description": "Agent company name（exact match, fuzzy match not supported）"
              },
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number, starting from 1"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page size, up to 100"
              }
            },
            "required": [
              "pageNum",
              "pageSize"
            ],
            "additionalProperties": false,
            "description": "ERP agency company list query request"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-compliance/save-skc-agency": {
      "id": 3001172,
      "method": "POST",
      "path": "/open-api/goods-compliance/save-skc-agency",
      "risk": "H",
      "description": "Bind SKC and the agency company. Bind SKC and agent company according to platform compliance requirements. The overall solution of the agent company, click to view the document. Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001172",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skc": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "skc"
                },
                "description": "skc"
              },
              "agencyType": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Primary type of agency company。0-EU responsible person; 1-UK agent; 2-US agent; 3-Manufacturer"
              },
              "agencyId": {
                "type": "string",
                "description": "Agency company ID。Can be obtained through Query declaration company list to get agencyId。"
              }
            },
            "required": [
              "skc",
              "agencyType"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "void",
      "allow_absent_result": true,
      "multipart": false
    },
    "POST /open-api/goods-compliance/skc-agency-detail": {
      "id": 3001855,
      "method": "POST",
      "path": "/open-api/goods-compliance/skc-agency-detail",
      "risk": "R",
      "description": "Query SKC's agency company binding requirements. Query which SKCs need to be bound to which types of agent companies, and the current binding status (this interface has a new interface that supports it; it is recommended to connect to the new interface first: /open-api/goods-compliance-requirements/list ) Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001855",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Number of items per page, maximum 100"
              },
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number, it is recommended to start querying from 1"
              },
              "skcList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC, supports batch query"
                },
                "description": "SKC, supports batch query"
              },
              "skcShelfStatusList": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Filter SKC listing status. 0-Pending listing, SKC status. 1-Listed, 2-Unlisted, 3-Sold out"
                },
                "description": "Filter SKC listing status. 0-Pending listing, SKC status. 1-Listed, 2-Unlisted, 3-Sold out"
              },
              "reviewStatusList": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Filter the binding status of SKC and agency company. 1-Pending binding; 2-Pending review (merchant backend will show binding successful, API layer can also be understood as binding successful); 3-Binding failed; 4-Binding successful."
                },
                "description": "Filter the binding status of SKC and agency company. 1-Pending binding; 2-Pending review (merchant backend will show binding successful, API layer can also be understood as binding successful); 3-Binding failed; 4-Binding successful."
              },
              "isRequired": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Filter whether SKC must bind a certain type of agency company. 0-No, 1-Yes, 10-Unknown (this is a transient state, the momentary state when a new SKC is generated)"
              }
            },
            "required": [
              "pageSize",
              "pageNum"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-compliance/query-warning-certificate-rules": {
      "id": 3001857,
      "method": "POST",
      "path": "/open-api/goods-compliance/query-warning-certificate-rules",
      "risk": "R",
      "description": "Query the filling rules of the warning text certificate. This API can retrieve all warning message certificate entry rules that require manual intervention from the merchant. For more details, please refer to the solution at https://open.sheincorp.com/documents/system/05911185-74f1-48d6-a620-fdfb756f6a86 . Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001857",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-compliance/update-skc-warning-certificate": {
      "id": 3001858,
      "method": "POST",
      "path": "/open-api/goods-compliance/update-skc-warning-certificate",
      "risk": "H",
      "description": "Update SKC warning text. Create/update a warning certificate for a specific SKC. For detailed input parameter methods, please refer to the solution Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001858",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "certificateTypeCode": {
                "type": "string",
                "description": "Certificate type code"
              },
              "fieldList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "fieldCode": {
                      "type": "string",
                      "description": "Certificate field code。Both regular fields and warning message fields need to be passed as parameters。For specific parameter passing methods, please refer to the Solution 。"
                    },
                    "fieldValues": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "fieldValueId": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Field value ID"
                          }
                        },
                        "required": [
                          "fieldValueId"
                        ],
                        "additionalProperties": false,
                        "description": "Field value list"
                      },
                      "description": "Field value list"
                    }
                  },
                  "required": [
                    "fieldCode",
                    "fieldValues"
                  ],
                  "additionalProperties": false,
                  "description": "Certificate field information"
                },
                "description": "Certificate field information"
              },
              "skcNames": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC platform code, supports batch operations, up to 100 at a time。"
                },
                "description": "SKC platform code, supports batch operations, up to 100 at a time。"
              }
            },
            "required": [
              "certificateTypeCode",
              "fieldList",
              "skcNames"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-compliance/query-skc-warning-status": {
      "id": 3001856,
      "method": "POST",
      "path": "/open-api/goods-compliance/query-skc-warning-status",
      "risk": "R",
      "description": "Query the binding status of SKC warning language. Query SKC warning message certificate binding requirements and status. (This interface has been replaced by a new one; it is recommended to prioritize connecting to the new interface: /open-api/goods-compliance-requirements/list ). For complete instructions on calling the warning message interface, please refer to the documentation: . Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001856",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "certificateTypeCodes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Certificate type code list，up to 20（Currently warning certificates are less than 20）。"
                },
                "description": "Certificate type code list，up to 20（Currently warning certificates are less than 20）。"
              },
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Number per page，up to 200"
              },
              "reviewStates": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Review status。0=Not submitted for review;1=Pending review;2=Review successful;3=Review rejected"
                },
                "description": "Review status。0=Not submitted for review;1=Pending review;2=Review successful;3=Review rejected"
              },
              "skcNames": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC platform code, up to 200"
                },
                "description": "SKC platform code, up to 200"
              }
            },
            "required": [
              "certificateTypeCodes",
              "pageNum",
              "pageSize"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-compliance/skc-label-list": {
      "id": 3001394,
      "method": "POST",
      "path": "/open-api/goods-compliance/skc-label-list",
      "risk": "R",
      "description": "Query SKC's real shot image requirements. Query which SKCs need to upload real photos, and what information elements need to be reflected in the real photos. The overall solution for real photo scenes, Click to view the document. Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001394",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Number of items per page, up to 100"
              },
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number, it is recommended to start querying from 1"
              },
              "skcList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC, supports batch query"
                },
                "description": "SKC, supports batch query"
              },
              "skcShelfStatusList": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "SKC's listing status. 0-Pending listing; 1-Listed; 2-Delisted; 3-Sold out"
                },
                "description": "SKC's listing status. 0-Pending listing; 1-Listed; 2-Delisted; 3-Sold out"
              },
              "reviewStatusList": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Review status of a certain information element in the real shot images uploaded by SKC. 1-Pending upload; 2-In effect; 3-Review not passed."
                },
                "description": "Review status of a certain information element in the real shot images uploaded by SKC. 1-Pending upload; 2-In effect; 3-Review not passed."
              },
              "isRequired": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Whether a certain information element must be reflected in the real shot images uploaded by SKC. 0-No, 1-Yes, 10-Unknown (momentary state when SKC is generated, can be ignored)"
              }
            },
            "required": [
              "pageSize",
              "pageNum",
              "skcList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-compliance/get-label-template": {
      "id": 3001373,
      "method": "POST",
      "path": "/open-api/goods-compliance/get-label-template",
      "risk": "R",
      "description": "Query SKC available label templates. The platform, based on the requirements of each country and region, has pre-set multiple label templates, such as the GPSR label template. The system will recommend available label templates for each SKC, and it is recommended that merchants use the platform's label templates for printing. Click here to view the printing process in the merchant backend. This interface allows querying detailed information about the available label templates for each SKC (including preview images). After viewing the preview, merchants can confirm the template to be used and print labels based on the template: /open-api/goods-compliance/label-print Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001373",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skc": {
                "type": "string",
                "description": "SKC code generated by the platform"
              }
            },
            "required": [
              "skc"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/goods-quality/environmental-label-rule/material-quality-tree-v2": {
      "id": 3001902,
      "method": "GET",
      "path": "/open-api/goods-quality/environmental-label-rule/material-quality-tree-v2",
      "risk": "R",
      "description": "Get full eco-friendly consumables information. To print an environmental label on a product, you must first obtain information on the environmentally friendly materials supported by the platform through this interface. The environmentally friendly material information has two layers: Material Type -> Specific Material. Applicable application modes: 1, 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001902",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-compliance/label-print": {
      "id": 3001385,
      "method": "POST",
      "path": "/open-api/goods-compliance/label-print",
      "risk": "H",
      "description": "Print compliance label. This interface supports printing product-related labels. The labels will contain a variety of information, including: environmental labels, GPSR, manufacturers, and product barcodes. Before printing labels, please check the label templates available to each SKC through the interface/open-api/good-compliance/get-label-template. Each template contains different information, and each information needs to provide different imported parameters. For example pictures of different label types, refer to the documentation . For the label printing process in the background of the merchant, please refer to the document . Applicable application modes: 1, 2, 3, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001385",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "labelDetailList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "labelType": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Label type. Examples of each type of printing can be found in the FAQ at the bottom of the document. 1-Environmental label: usually contains environmental information 2-GPSR label: usually contains GPSR information (may also have environmental label, product barcode, manufacturer information) 3-Merchant customized: undefined content, this type of label is created by the merchant in the back-end. Specific information can be queried at /open-api/goods-compliance/get-label-template. 4-GPSR+Environmental label: usually contains GPSR and environmental information. 5-Product barcode combined label: usually contains product barcode (may also have environmental label, product barcode, manufacturer information)"
                    },
                    "labelCode": {
                      "type": "string",
                      "description": "Printed label template code。Obtain through /open-api/goods-compliance/get-label-template Not mandatory, if not provided, the system will match all printable labels of the SKC based on the input SKC and labelType for printing。"
                    },
                    "printNumber": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Label printing quantity。 Not mandatory, it will only take effect if labelCode is provided。If not provided, the default is to print 1 copy of each label。"
                    },
                    "packageTypeId": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "This field will be deprecated later, use packageMaterialList as input parameter (supports printing multiple environmental materials in one label)."
                    },
                    "packageMaterialId": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "This field will be deprecated later, use packageMaterialList as input parameter (supports printing multiple environmental materials in one label)."
                    },
                    "packageMaterialList": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "packageTypeId": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Environmental material type ID. Can be obtained through the interface Get full environmental material information (new) . Usually labelType=1/2/4/5 can be used as a parameter, but whether the final print result will have environmental material information depends on whether the label template contains the environmental material variable."
                          },
                          "packageMaterialId": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Environmental material ID. Can be obtained through the interface Get full environmental material information (new) . Usually labelType=1/2/4/5 can be used as a parameter, but whether the final print result will have environmental material information depends on whether the label template contains the environmental material variable."
                          }
                        },
                        "required": [],
                        "additionalProperties": false,
                        "description": "Environmental material list. Supports printing multiple environmental materials in one label, up to 10 materials. When the label contains environmental information, this list needs to be included as a parameter. Usually labelType=1/2/4/5 can be used as a parameter, but whether the final print result will have environmental material information depends on whether the label template contains the environmental material variable."
                      },
                      "description": "Environmental material list. Supports printing multiple environmental materials in one label, up to 10 materials. When the label contains environmental information, this list needs to be included as a parameter. Usually labelType=1/2/4/5 can be used as a parameter, but whether the final print result will have environmental material information depends on whether the label template contains the environmental material variable."
                    },
                    "skc": {
                      "type": "string",
                      "description": "Platform-generated unique SKC code. Mandatory, regardless of the type of label, it must be provided."
                    },
                    "skuCode": {
                      "type": "string",
                      "description": "SKU displayed in the product barcode. When the label contains barcode information, skucode and suppliersku choose one to be used as a parameter, Usually labelType=2/4/5 can be used as a parameter, but whether the final print result will have product barcode information depends on whether the label template contains the product barcode variable."
                    },
                    "supplierSku": {
                      "type": "string",
                      "description": "SKU displayed in the product barcode. When the label contains barcode information, skucode and suppliersku choose one to be used as a parameter, Usually labelType=2/4/5 can be used as a parameter, but whether the final print result will have product barcode information depends on whether the label template contains the product barcode variable."
                    },
                    "orderNo": {
                      "type": "string",
                      "description": "Purchase order number displayed in the product barcode。Use when the label contains barcode information, not mandatory, if no value is provided, the number will be displayed as empty。 Usually, when labelType=2/4/5, it can be used as input, but whether the final print result will contain product barcode information depends on whether the label template contains variable information of the product barcode。"
                    },
                    "originCountry": {
                      "type": "string",
                      "description": "Country of origin. Used when the label contains GPSR information, custom value entered by the merchant, fill in the country name. Usually labelType=2/4/5 can be used as a parameter."
                    },
                    "productBatchNo": {
                      "type": "string",
                      "description": "Product batch number. Used when the label contains GPSR information, custom value entered by the merchant. Usually labelType=2/4/5 can be used as a parameter."
                    },
                    "warning": {
                      "type": "string",
                      "description": "Warning。Use when the label contains GPSR information, custom input value by the merchant。 Usually, when labelType=2/4/5, it can be used as input。"
                    },
                    "uid": {
                      "type": "string",
                      "description": "Location ID of the print rules. The location ID of each line must be unique. Custom input by the developer, used to determine which rule failed or succeeded in printing."
                    }
                  },
                  "required": [
                    "labelType",
                    "skc",
                    "uid"
                  ],
                  "additionalProperties": false,
                  "description": "Print rule list。That is, provide specific labels for what content to print。A maximum of 10 sets of rules are supported at a time, too many may cause response timeout。 Before printing labels, please first query the label template available for each SKC through the interface /open-api/goods-compliance/get-label-template。Each template contains different information, and each piece of information requires different input parameters。"
                },
                "description": "Print rule list。That is, provide specific labels for what content to print。A maximum of 10 sets of rules are supported at a time, too many may cause response timeout。 Before printing labels, please first query the label template available for each SKC through the interface /open-api/goods-compliance/get-label-template。Each template contains different information, and each piece of information requires different input parameters。"
              }
            },
            "required": [],
            "additionalProperties": false,
            "description": "req"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods-compliance/upload-skc-label-picture": {
      "id": 3001176,
      "method": "POST",
      "path": "/open-api/goods-compliance/upload-skc-label-picture",
      "risk": "W",
      "description": "Upload real shot image. When binding SKC, you need to use the image URL for real-shot images. Please use this interface to upload local images to get the URL. Comprehensive solution for real-shot image scenarios, click to view the document. Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001176",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
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
                "description": "Local image file。Image width and height must not exceed 8000px, size must not exceed 10M, supports png/jpeg/jpg format"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": true
    },
    "POST /open-api/goods-compliance/skc-save-label": {
      "id": 3001399,
      "method": "POST",
      "path": "/open-api/goods-compliance/skc-save-label",
      "risk": "H",
      "description": "Bind SKC and real shot image. Bind SKC and real pictures. If the real picture information meets the requirements, the binding is successful. The overall solution for real picture scenes, Click to view the documentation. Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001399",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skcList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC"
                },
                "description": "SKC"
              },
              "packageLableList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "imageUrl": {
                      "type": "string",
                      "description": "Image url。 Needs to be obtained through interface conversion /open-api/goods-compliance/label-print"
                    },
                    "imageMd5": {
                      "type": "string",
                      "description": "The md5 of the image. Must be obtained by converting through /open-api/goods-compliance/label-print"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "Real photo of the packaging type label"
                },
                "description": "Real photo of the packaging type label"
              },
              "bodyLableList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "imageUrl": {
                      "type": "string",
                      "description": "Image url。 Needs to be obtained through interface conversion /open-api/goods-compliance/label-print"
                    },
                    "imageMd5": {
                      "type": "string",
                      "description": "The md5 of the image. Must be obtained by converting through /open-api/goods-compliance/label-print"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "Real photo of the product body label"
                },
                "description": "Real photo of the product body label"
              },
              "skcLablePicList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "imageUrl": {
                      "type": "string",
                      "description": "This field will be deprecated in the future, please do not integrate it anymore."
                    },
                    "imageMd5": {
                      "type": "string",
                      "description": "This field will be deprecated in the future, please do not integrate it anymore."
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "This field will be deprecated in the future, please do not integrate it anymore."
                },
                "description": "This field will be deprecated in the future, please do not integrate it anymore."
              }
            },
            "required": [
              "skcList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/sem/feed/createFeed": {
      "id": 3001230,
      "method": "POST",
      "path": "/open-api/sem/feed/createFeed",
      "risk": "H",
      "description": "Create Feed. Submit an existing provider Feed document. Feed creation is asynchronous; query getFeed for the result. The host document upload workflow is not yet integrated. Applicable application modes: 1. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001230",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "feedDocumentId": {
                "type": "string",
                "description": "Name of the feed file"
              },
              "feedType": {
                "type": "string",
                "description": "Processing method of the file, currently supporting 'PRODUCT_LISTING'"
              },
              "version": {
                "type": "string",
                "description": "Version; default is missing"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/sem/feed/getFeed": {
      "id": 3001234,
      "method": "GET",
      "path": "/open-api/sem/feed/getFeed",
      "risk": "R",
      "description": "Get Feed Result.  Applicable application modes: 1. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001234",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "feedId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "feedId; obtained by creating a Feed task"
              }
            },
            "required": [
              "feedId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/sem/feed/cancelFeed": {
      "id": 3001233,
      "method": "POST",
      "path": "/open-api/sem/feed/cancelFeed",
      "risk": "D",
      "description": "Cancel Feed. Only Feed tasks in the queue (IN_QUEUE) status can be canceled Applicable application modes: 1. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001233",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "feedId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "feedId；form-data"
              }
            },
            "required": [
              "feedId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/order/order-list": {
      "id": 3001921,
      "method": "POST",
      "path": "/open-api/order/order-list",
      "risk": "R",
      "description": "Query order list API. This interface retrieves the order list; it is suitable for self-operated and semi-managed applications; alternatively, the latest order information can be detected using the Order Synchronization Notification in the webhook. It supports querying by order creation and update times; the time range for the query conditions startTime and endTime is limited to 48 hours, and the total number of query results is limited to 10,000; if the number of orders in the query range exceeds 10,000, the creation time of the last order in the last query should be used as the \"startTime\" for the next query. Note: The timezone for interface request and response times is UTC+8 (Beijing time). Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001921",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "queryType": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Query types: 1: Query by order placement time / 2: Query by order update time (the placement time will be synchronized with the update time when the order is placed);",
                "enum": [
                  1,
                  2
                ]
              },
              "startTime": {
                "type": "string",
                "description": "Start Time; Example: 2024-12-12 15:38:29 (UTC+8). The time range for `startTime` and `endTime` is limited to 48 hours, and the total number of query results is limited to 10,000. If the number of orders within the query range exceeds 10,000, the time of the last order in the last query should be used as the `startTime` for the next query."
              },
              "endTime": {
                "type": "string",
                "description": "End time; Example: 2024-12-12 15:38:29 (UTC+8). The time range for `startTime` and `endTime` is limited to 48 hours, and the total number of query results is limited to 10,000. If the number of orders within the query range exceeds 10,000, the time of the last order in the last query should be used as the `startTime` for the next query."
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991,
                "description": "Page number"
              },
              "pageSize": {
                "type": "integer",
                "minimum": 1,
                "maximum": 30,
                "description": "Number of items returned per page; Please set an integer between 1 and 30"
              },
              "orderStatus": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Order status: 1: Pending processing/ 2: Pending shipment/ 3: Pending shein shipment/ 4: Shipped/ 5: Delivered/ 6: User refunded/ 7: Pending collection/ 8: Reported damage/ 9: Rejected"
              },
              "queryOrderType": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Query the orders corresponding to the type of shipping warehouse; 1: Certified warehouse shipping orders / 2: SHEIN warehouse shipping orders / 3: Merchant warehouse shipping orders / 4: All orders; If not provided, Brazilian merchants will return merchant warehouse shipping orders, while other country markets will return SHEIN warehouse and merchant warehouse shipping orders"
              },
              "cteInvoiceStatus": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Brazil market CTE billing status；1: All packages under the order (except canceled ones) have completed billing/ 2: There are packages under the order with incomplete billing"
              },
              "nfeInvoiceStatus": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Brazil market NFE invoicing status;1:Completed NFE invoicing/ 2:Incomplete NFE invoicing (for Brazilian sellers, when order invoice information is synchronized through return invoice information, status changes from 2 to 1)/ 3:Need to retransmit NFE invoice/ 4:No need to issue NFE invoice"
              }
            },
            "required": [
              "queryType",
              "startTime",
              "endTime",
              "page",
              "pageSize"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/order/order-detail": {
      "id": 3001915,
      "method": "POST",
      "path": "/open-api/order/order-detail",
      "risk": "R",
      "description": "Query order detail API. This interface retrieves order details from self-operated and semi-managed merchants; all times returned by the interface are Beijing time (UTC+8); For instructions on order integration, please refer to ERP Order Fulfillment Solution ; Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001915",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "orderNoList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Order Number List; Up to 30 items;"
                },
                "description": "Order Number List; Up to 30 items;"
              }
            },
            "required": [
              "orderNoList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/order/export-address": {
      "id": 3001924,
      "method": "POST",
      "path": "/open-api/order/export-address",
      "risk": "H",
      "description": "Export address API. handleType=2 can change order status; both address export variants use the high-impact lane. Authorized recipient details are returned. Applicable application modes: 1, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001924",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "orderNo": {
                "type": "string",
                "description": "Order Number"
              },
              "handleType": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "1: Only export the recipient's address information; the order status remains unchanged. Applicable to invoice issuance scenarios in the Brazilian market. 2: Export the recipient's address information and change the order status from \"Pending Processing (1)\" to \"Pending Shipment (2)\". Only applicable to merchant-shipped scenarios (optionalLogisticsList in the order details interface contains 2 and orderLogisticsType=2); online orders do not require obtaining the buyer's address.",
                "enum": [
                  1,
                  2
                ]
              }
            },
            "required": [
              "orderNo",
              "handleType"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/order/express-channel": {
      "id": 3001916,
      "method": "POST",
      "path": "/open-api/order/express-channel",
      "risk": "R",
      "description": "Query channel information at the merchant level. This API supports self-operated, semi-managed sellers to query available logistics information in self-fulfillment scenarios; Please refer to the solution before integration: ERP Order Fulfillment Solution Note: The API returns available logistics channels at the merchant level, not all available logistics channels on the SHEIN platform; Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001916",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "warehouseAddressCode": {
                "type": "string",
                "description": "Warehouse address code; if left blank, only the merchant's self-shipping channels are returned; if entered, it can accurately match the available self-shipping and shein cooperative logistics channels under this address and sales site ; value is obtained from the Query Warehouse Address interface"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/order/import-batch-multiple-express": {
      "id": 3001274,
      "method": "POST",
      "path": "/open-api/order/import-batch-multiple-express",
      "risk": "D",
      "description": "Upload expresses info API. Mixed update/delete operation uses the destructive lane. Empty returned info means no failed waybills; a nonempty array contains failures. Waybill upload does not establish carrier pickup or shipment. Applicable application modes: 1, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001274",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "orderNo": {
                "type": "string",
                "description": "Order Number"
              },
              "infoList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "expressCode": {
                      "type": "string",
                      "description": "Waybill number; if the logistics company's waybill number format is incorrect, it will not pass validation."
                    },
                    "expressIdCode": {
                      "type": "string",
                      "description": "Logistics companies available to merchants，obtained through 【 Query shipping channels 】"
                    },
                    "expressChannelCode": {
                      "type": "string",
                      "description": "Channel merchant product code，obtained through 【 Query shipping channels 】"
                    },
                    "goodsId": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Unique identifier of the product; if multiple pieces of the same product, each goodsId is different, obtained through the order details API."
                    },
                    "status": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Should waybill information be deleted; 1. Delete order waybill information based on goodsId; 2. Update waybill information."
                    },
                    "goodExpressRemarkDto": {
                      "type": "object",
                      "properties": {
                        "handleExpressRemark": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Operation type this time；1:Add or update additional waybill logistics information/ 2:Delete additional waybill logistics information"
                        },
                        "orderGoodsExpressRemarkList": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "expressCode": {
                                "type": "string",
                                "description": "Waybill number"
                              },
                              "expressIdCode": {
                                "type": "string",
                                "description": "Logistics companies available to merchants，obtained through 【 Query shipping channels 】"
                              },
                              "expressChannelCode": {
                                "type": "string",
                                "description": "Channel merchant product code，obtained through 【 Query shipping channels 】"
                              }
                            },
                            "required": [
                              "expressCode",
                              "expressIdCode"
                            ],
                            "additionalProperties": false,
                            "description": "Additional waybill logistics information"
                          },
                          "description": "Additional waybill logistics information"
                        }
                      },
                      "required": [
                        "handleExpressRemark"
                      ],
                      "additionalProperties": false,
                      "description": "Used to supplement package waybill information in scenarios where multiple packages of the same SKU are sent for large items，note that not all merchants have this operation permission；"
                    }
                  },
                  "required": [
                    "expressCode",
                    "expressIdCode",
                    "goodsId",
                    "status"
                  ],
                  "additionalProperties": false,
                  "description": "Waybill information, up to 100 can be transmitted."
                },
                "description": "Waybill information, up to 100 can be transmitted."
              }
            },
            "required": [
              "orderNo",
              "infoList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/gsp/warehouse-address": {
      "id": 3001786,
      "method": "POST",
      "path": "/open-api/gsp/warehouse-address",
      "risk": "R",
      "description": "Query warehouse address. The warehouse address information is obtained via an interface for online order placement; Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001786",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/gsp/available-shipping-warehouse": {
      "id": 3001815,
      "method": "POST",
      "path": "/open-api/gsp/available-shipping-warehouse",
      "risk": "R",
      "description": "Query available shipping warehouses for the order. This provides an interface to query available shipping warehouses for order-level data in the online ordering business; Please refer to Common Reasons for Warehouse Unavailability and Solutions for more comprehensive information Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001815",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "orderNo": {
                "type": "string",
                "description": "Order Number"
              }
            },
            "required": [
              "orderNo"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/gsp/order-mapping-channels": {
      "id": 3001934,
      "method": "POST",
      "path": "/open-api/gsp/order-mapping-channels",
      "risk": "R",
      "description": "Query available logistics information for the order. Provides an interface to query available logistics channels for order-related data in the online ordering business; Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001934",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "orderNo": {
                "type": "string",
                "description": "Order Number"
              },
              "packageSizeInfo": {
                "type": "object",
                "properties": {
                  "packageHeight": {
                    "type": "string",
                    "description": "Height"
                  },
                  "packageLength": {
                    "type": "string",
                    "description": "Length"
                  },
                  "packageWidth": {
                    "type": "string",
                    "description": "Width"
                  },
                  "unit": {
                    "type": "string",
                    "description": "Unit (currently only supports cm)"
                  }
                },
                "required": [
                  "packageHeight",
                  "packageLength",
                  "packageWidth",
                  "unit"
                ],
                "additionalProperties": false,
                "description": "Package Size. When a multi-item order needs to be split into multiple packages, this interface must be called separately for each package, passing in the corresponding package size. Note: Orders already placed online cannot have their package details modified (i.e., the item allocation within the package cannot be changed)."
              },
              "packageWeightInfo": {
                "type": "object",
                "properties": {
                  "packageWeight": {
                    "type": "string",
                    "description": "Weight, supports decimals"
                  },
                  "unit": {
                    "type": "string",
                    "description": "Unit (currently only supports g)"
                  }
                },
                "required": [
                  "packageWeight",
                  "unit"
                ],
                "additionalProperties": false,
                "description": "Package weight. When a multi-item order needs to be split into multiple packages, this interface must be called separately for each package, with the corresponding weight passed in. Note: Orders already placed online cannot have their package details modified (i.e., the item allocation within the package cannot be changed)."
              },
              "prePackageInfo": {
                "type": "object",
                "properties": {
                  "goodsIds": {
                    "type": "array",
                    "items": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "A list of product IDs, used to specify which products are included in the current package. Input rules: COD orders: Regardless of the quantity of products, must be entered > Non-COD orders: Do not enter, entering will result in an error > Note: Single-product orders do not support splitting packages (COD orders still require the goodsId)"
                    },
                    "description": "A list of product IDs, used to specify which products are included in the current package. Input rules: COD orders: Regardless of the quantity of products, must be entered > Non-COD orders: Do not enter, entering will result in an error > Note: Single-product orders do not support splitting packages (COD orders still require the goodsId)"
                  }
                },
                "required": [],
                "additionalProperties": false,
                "description": "Pre-package information. Required in the following scenarios: 1) COD orders (cash on delivery, determined by the isCod field in the order details interface);"
              },
              "warehouseAddressCode": {
                "type": "string",
                "description": "Warehouse address code"
              }
            },
            "required": [
              "orderNo",
              "packageSizeInfo",
              "packageWeightInfo",
              "warehouseAddressCode"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/gsp/place-express-order": {
      "id": 3001918,
      "method": "POST",
      "path": "/open-api/gsp/place-express-order",
      "risk": "H",
      "description": "Online order. Read available channels first. Creation is asynchronous: query check-express-order with placeRequestId before printing. Never replay an uncertain order. Applicable application modes: 1, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001918",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "expressChannelCode": {
                "type": "string",
                "description": "Channel provider product code;"
              },
              "packageInfoList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "orderNo": {
                      "type": "string",
                      "description": "Order Number"
                    },
                    "goodsIds": {
                      "type": "array",
                      "items": {
                        "type": "integer",
                        "minimum": -9007199254740991,
                        "maximum": 9007199254740991,
                        "description": "The unique ID of each item。If a SKU has multiple pieces, each piece's goodsId is unique and can be obtained from /open-api/order/order-detail。When passing it in, it must be consistent with the goodsIds passed in when previously calling the /open-api/gsp/order-mapping-channels API。 If not provided, by default all items in the order will be placed in one parcel。"
                      },
                      "description": "The unique ID of each item。If a SKU has multiple pieces, each piece's goodsId is unique and can be obtained from /open-api/order/order-detail。When passing it in, it must be consistent with the goodsIds passed in when previously calling the /open-api/gsp/order-mapping-channels API。 If not provided, by default all items in the order will be placed in one parcel。"
                    }
                  },
                  "required": [
                    "orderNo"
                  ],
                  "additionalProperties": false,
                  "description": "Package details; (currently supports single order multiple packages)"
                },
                "description": "Package details; (currently supports single order multiple packages)"
              },
              "preRequestId": {
                "type": "string",
                "description": "Channel pre-check request ID；obtained by calling the /open-api/gsp/order-mapping-channels API"
              }
            },
            "required": [
              "expressChannelCode",
              "packageInfoList",
              "preRequestId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/gsp/check-express-order": {
      "id": 3001919,
      "method": "POST",
      "path": "/open-api/gsp/check-express-order",
      "risk": "R",
      "description": "Query order result. Check the order results for online orders via logistics channels Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001919",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "placeRequestId": {
                "type": "string",
                "description": "Order request ID; (order request ID and delivery number cannot both be empty); obtained by calling the 【Place Order Online】/open-api/gsp/place-express-order interface"
              },
              "deliveryNo": {
                "type": "string",
                "description": "Waybill number；(Order request id and waybill number cannot be empty at the same time)"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/gsp/switch-self-shipping": {
      "id": 3001922,
      "method": "POST",
      "path": "/open-api/gsp/switch-self-shipping",
      "risk": "H",
      "description": "Switch export address to shipping. This interface is only available after merchants place orders online through SHEIN's partner logistics provider. It is used to switch to merchant self-fulfillment mode (merchants contact logistics providers to ship the goods themselves). Only orders from the US and Europe are supported. How to determine if an order is eligible for this API call : Query the order via /open-api/order/order-detail. The following conditions must be met simultaneously: optionalLogisticsList=[1,2] (The order supports online ordering + self-fulfillment) orderLogisticsType = 1 (The merchant currently selects online ordering) orderStatus = 1 or 2 or 7 (The order has not been shipped) If the above conditions are not met, the call will return an error. Applicable application modes: 1, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001922",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "orderNo": {
                "type": "string",
                "description": "Order number; (after calling the interface, self-shipping is done, platform logistics can no longer be used for shipping)"
              }
            },
            "required": [
              "orderNo"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "void",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/order/sync-invoice-info": {
      "id": 3001923,
      "method": "POST",
      "path": "/open-api/order/sync-invoice-info",
      "risk": "H",
      "description": "Sync invoice info to SHEIN API. This interface is used by merchants in the Brazilian market to synchronize order invoice information to the SHEIN platform. After successful invoice upload, the platform will automatically issue a CTE invoice. The invoice status will be proactively pushed via Webhook: /invoice_status_notice . Please subscribe in advance. Applicable application modes: 1. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001923",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "orderInvoiceInfos": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "orderNo": {
                      "type": "string",
                      "description": "Order Number"
                    },
                    "unpackingGroupNo": {
                      "type": "string",
                      "description": "Package Group Number; Obtained through order details API"
                    },
                    "ie": {
                      "type": "string",
                      "description": "I.E. - State Registration Number, Can be left empty, only send invoiceXmlContent"
                    },
                    "icms": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "1-TAXED Requires Tax Payment; 2 NO-TAXED No Tax Required; 3-FERR Individual Seller"
                    },
                    "invoiceNo": {
                      "type": "string",
                      "description": "Invoice number; Maximum length: 100 characters; Can only be empty when sending invoiceXmlContent"
                    },
                    "invoiceKey": {
                      "type": "string",
                      "description": "Invoice key; Maximum length: 100 characters; Can only be empty when sending invoiceXmlContent"
                    },
                    "invoiceSn": {
                      "type": "string",
                      "description": "Invoice series number; Maximum length: 100 characters; Can only be empty when sending invoiceXmlContent"
                    },
                    "amount": {
                      "type": "number",
                      "description": "Invoice total amount; Data type: BigDecimal(10,2); Can only be empty when sending invoiceXmlContent"
                    },
                    "taxNo": {
                      "type": "string",
                      "description": "Tax number, maximum length 100, can be empty, only send invoiceXmlContent"
                    },
                    "currency": {
                      "type": "string",
                      "description": "Currency (e.g., BRL), can be empty, only send invoiceXmlContent"
                    },
                    "invoiceType": {
                      "type": "string",
                      "description": "Invoice type (invoice import/export type, platform side invoices only have shipments. Brazil site, bio information: Saída), can be empty, only send invoiceXmlContent"
                    },
                    "authorizationNumber": {
                      "type": "string",
                      "description": "Invoice authorization number (e.g., 135220009577779), can be empty, only send invoiceXmlContent"
                    },
                    "authorizationTime": {
                      "type": "string",
                      "description": "Invoice authorization time (e.g., 2022-12-04 00:00:00), can be empty, only send invoiceXmlContent"
                    },
                    "invoiceIssueTime": {
                      "type": "string",
                      "description": "Invoice issuance time (e.g., 2022-12-04 10:00:00), can be empty, only send invoiceXmlContent"
                    },
                    "quantity": {
                      "type": "string",
                      "description": "Total quantity on the invoice. BigDecimal(15,4), can be empty, only send invoiceXmlContent"
                    },
                    "invoiceXmlContent": {
                      "type": "string",
                      "description": "Invoice xml content.The parameter hopefully the entire text can be transferred.If not, need to be URLencode with UTF-8. For Example: Before:"
                    },
                    "sendMsg": {
                      "type": "object",
                      "properties": {
                        "name": {
                          "type": "string",
                          "description": "Name (Upload sender's name or company name)"
                        },
                        "taxNo": {
                          "type": "string",
                          "description": "Tax number (e.g., 99867389620, business's CNPJ tax number is 14 digits, individual's CPF tax number is 11 digits)"
                        },
                        "ie": {
                          "type": "string",
                          "description": "I.E. - State Registration (e.g., 99867389620; if the entity is a company (exempt) or an individual, enter \"EXEMPT\" here to indicate exemption)"
                        },
                        "stateProvinceCode": {
                          "type": "string",
                          "description": "Two-character code for State and Province (e.g., SP)"
                        },
                        "cityCode": {
                          "type": "string",
                          "description": "City code (for example: 3518800)"
                        },
                        "city": {
                          "type": "string",
                          "description": "City (for example: GUARULHOS)"
                        },
                        "neighborhood": {
                          "type": "string",
                          "description": "Region (for example: CUMBICA, if not, default use S/N)"
                        },
                        "street": {
                          "type": "string",
                          "description": "Street (for example: AVENIDA ORLANDA BERGAMO ESQUINA COM A AVENIDA ABRAAO LINCOLN, if not, default use S/N)"
                        },
                        "houseNumber": {
                          "type": "string",
                          "description": "House number (for example: 1132, if not, default use S/N)"
                        },
                        "zipCode": {
                          "type": "string",
                          "description": "Postal code (for example: 13236533)"
                        }
                      },
                      "required": [
                        "name",
                        "taxNo",
                        "stateProvinceCode",
                        "cityCode",
                        "city",
                        "neighborhood",
                        "street",
                        "houseNumber",
                        "zipCode"
                      ],
                      "additionalProperties": false,
                      "description": "Sender information"
                    },
                    "receiveMsg": {
                      "type": "object",
                      "properties": {
                        "name": {
                          "type": "string",
                          "description": "Name (Enter the recipient's name or company name)"
                        },
                        "taxNo": {
                          "type": "string",
                          "description": "Tax number (e.g., 99867389620, business's CNPJ tax number is 14 digits, individual's CPF tax number is 11 digits)"
                        },
                        "ie": {
                          "type": "string",
                          "description": "I.E. - State Registration (e.g., 99867389620; if the entity is a company (exempt) or an individual, enter \"EXEMPT\" here to indicate exemption)"
                        },
                        "stateProvinceCode": {
                          "type": "string",
                          "description": "Two-character code for State and Province (e.g., SP)"
                        },
                        "cityCode": {
                          "type": "string",
                          "description": "City code (for example: 3518800)"
                        },
                        "city": {
                          "type": "string",
                          "description": "City (for example: GUARULHOS)"
                        },
                        "neighborhood": {
                          "type": "string",
                          "description": "Region (for example: CUMBICA, if not, default use S/N)"
                        },
                        "street": {
                          "type": "string",
                          "description": "Street (for example: AVENIDA ORLANDA BERGAMO ESQUINA COM A AVENIDA ABRAAO LINCOLN, if not, default use S/N)"
                        },
                        "houseNumber": {
                          "type": "string",
                          "description": "House number (for example: 1132, if not, default use S/N)"
                        },
                        "zipCode": {
                          "type": "string",
                          "description": "Postal code (for example: 13236533)"
                        }
                      },
                      "required": [
                        "name",
                        "taxNo",
                        "stateProvinceCode",
                        "cityCode",
                        "city",
                        "neighborhood",
                        "street",
                        "houseNumber",
                        "zipCode"
                      ],
                      "additionalProperties": false,
                      "description": "Recipient Information"
                    }
                  },
                  "required": [
                    "orderNo",
                    "icms",
                    "sendMsg",
                    "receiveMsg"
                  ],
                  "additionalProperties": false,
                  "description": "Upload Invoice Information, Maximum 50 records in one API call"
                },
                "description": "Upload Invoice Information, Maximum 50 records in one API call"
              }
            },
            "required": [
              "orderInvoiceInfos"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "json",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/order/print-express-info": {
      "id": 3001925,
      "method": "POST",
      "path": "/open-api/order/print-express-info",
      "risk": "H",
      "description": "Print express info API. When using SHEIN's partner logistics for fulfillment, developers can call this interface to print shipping labels. The shipping label URL is valid for 1 hour; please download and save it promptly; QPS should not exceed 20. How to determine if a shipping label can be printed? Call the order details interface. If `optionalLogisticsList` contains 1, it means the order needs to use SHEIN's partner logistics for fulfillment. This is differentiated by `orderPlaceType`: `orderPlaceType=1 (Platform-specified logistics) : Mexico market: After obtaining the order (without refunds, exchanges, or other anomalies), you can directly call to print the shipping label. Brazil market: You need to first upload the invoice via `/open-api/order/sync-invoice-info` and wait for the CTE invoice to be issued (obtain the status via Webhook:/invoice_status_notice) before you can call to print the shipping label. orderPlaceType=2 (Merchant specifies SHEIN's partner logistics, i.e., online ordering) : Successfully calling the online ordering interface does not mean the order is complete. Because SHEIN and its partner logistics use an asynchronous ordering process, you must first call the order result query interface to confirm handleResult=2 (order successful) before you can call to print the shipping label. Applicable application modes: 1, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001925",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "orderNo": {
                "type": "string",
                "description": "Order number (in the case of platform-specified logistics, i.e., orderPlaceType=1, input parameter orderNo+packageNo to obtain the shipping label)"
              },
              "packageNo": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Package number (in the case of platform-specified logistics, i.e., orderPlaceType=1, input parameter orderNo+packageNo to obtain the waybill)"
                },
                "description": "Package number (in the case of platform-specified logistics, i.e., orderPlaceType=1, input parameter orderNo+packageNo to obtain the waybill)"
              },
              "deliveryNo": {
                "type": "string",
                "description": "The waybill number (in the case of online orders, i.e., `orderPlaceType=2` is the parameter for printing the waybill); obtain it from the Query Order Result interface. Only after confirming `handleResult=2 (order successful)` can the \"Print Waybill\" function be called."
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/gsp/logistics-track": {
      "id": 3001814,
      "method": "GET",
      "path": "/open-api/gsp/logistics-track",
      "risk": "R",
      "description": "Customer order logistics tracking inquiry. Use this interface to check the logistics tracking information of forward orders or reverse return orders; Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001814",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "orderNo": {
                "type": "string",
                "description": "Forward order number；Either forward order number or return order number must be filled；When querying forward order number, either package number or waybill number must be filled；"
              },
              "packageNo": {
                "type": "string",
                "description": "Package number；In case of multiple waybills under the package, all waybill information will be returned；"
              },
              "waybillNo": {
                "type": "string",
                "description": "Waybill number；Return information according to the specified waybill number；"
              },
              "returnOrderNo": {
                "type": "string",
                "description": "Return order number；"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/order/confirm-no-stock": {
      "id": 3001415,
      "method": "POST",
      "path": "/open-api/order/confirm-no-stock",
      "risk": "H",
      "description": "Confirmation of no goods API. This API allows merchants to cancel items in an order. After calling this interface, when the developer calls the order details interface again, they can find that the product's storageTag field will change from 1 to 3. After a period of time, the system will change the order status field of the product newGoodsStatus to 6 (Refund). ⚠️ Note: Frequent order cancellations may result in penalties for the store, so please be careful. Applicable application modes: 1, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001415",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skuCode": {
                "type": "string",
                "description": "SHEIN platform generated skuCode; skuCode and orderGoodsId cannot be empty at the same time"
              },
              "orderNo": {
                "type": "string",
                "description": "Order Number"
              },
              "orderGoodsId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Unique identifier of the product; if multiple pieces of the same product, each goodsId is different, obtained through the order details API."
              }
            },
            "required": [
              "orderNo",
              "orderGoodsId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/order/unpacking-group-remove": {
      "id": 3001279,
      "method": "POST",
      "path": "/open-api/order/unpacking-group-remove",
      "risk": "D",
      "description": "Cancel splitting order packages. This interface is used when orders in the Brazilian and Mexican markets exceed the limit and need to be unpacked. ERP needs to determine whether the order needs to be unpacked based on the order detail field (\"isOverLimitOrder\": 1). Please note: Once the unpacking of the Brazilian market order is confirmed, the corresponding invoices need to be uploaded separately according to the split package number; for more information, please see Unpacking solution; Applicable application modes: 1, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001279",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "orderNo": {
                "type": "string",
                "description": "Order Number"
              }
            },
            "required": [
              "orderNo"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "void",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/order/unpacking-group-confirm": {
      "id": 3001280,
      "method": "POST",
      "path": "/open-api/order/unpacking-group-confirm",
      "risk": "H",
      "description": "Confirm splitting order packages. This interface is used when orders in the Brazilian and Mexican markets exceed the limit and need to be unpacked. ERP needs to determine whether the order needs to be unpacked based on the order detail field (\"isOverLimitOrder\": 1). Please note: Once the unpacking of the Brazilian market order is confirmed, the corresponding invoices need to be uploaded separately according to the split package number; for more information, please see Unpacking solution; Applicable application modes: 1, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001280",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "orderNo": {
                "type": "string",
                "description": "Order Number"
              }
            },
            "required": [
              "orderNo"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "void",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/return-order/list": {
      "id": 3001281,
      "method": "POST",
      "path": "/open-api/return-order/list",
      "risk": "R",
      "description": "Query return order list. Use this interface to get the return order list; for how to connect the return order, please see Customer order return and refund service; Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001281",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "queryType": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Time query dimension type: 1: Time when the return order is issued to the merchant/ 2: Time when the buyer applies for a return/ 3: Return order update time"
              },
              "startTime": {
                "type": "string",
                "description": "yyyy-MM-dd HH:mm:ss defaults to query data within 48 hours"
              },
              "endTime": {
                "type": "string",
                "description": "yyyy-MM-dd HH:mm:ss defaults to query data within 48 hours"
              },
              "page": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Request page number"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "limit【1,30】"
              },
              "returnOrderStatus": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "1: Closed/ 2: Applied/ 3: Cancelled/ 5: Received/ 6: Delivered/ 7: Pending handover/ 8: Pending SHEIN warehouse transfer/ 9: Completed"
              }
            },
            "required": [
              "queryType",
              "startTime",
              "endTime",
              "page",
              "pageSize"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/return-order/details": {
      "id": 3001282,
      "method": "POST",
      "path": "/open-api/return-order/details",
      "risk": "R",
      "description": "Query return order details. Use this interface to get return order details; for how to connect the return order, please see Customer order return and refund service; Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001282",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "returnOrderNoList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Up to 30 items"
                },
                "description": "Up to 30 items"
              }
            },
            "required": [
              "returnOrderNoList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "array",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/return-order/sign-return-order": {
      "id": 3001283,
      "method": "POST",
      "path": "/open-api/return-order/sign-return-order",
      "risk": "H",
      "description": "Receive return order. Through this interface, sign for returned goods; Applicable application modes: 1, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001283",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "returnOrderNo": {
                "type": "string",
                "description": "Return order number"
              },
              "goodsIdList": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "List of signed returned product Ids"
                },
                "description": "List of signed returned product Ids"
              }
            },
            "required": [
              "returnOrderNo",
              "goodsIdList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/order/purchase-order-infos": {
      "id": 3002009,
      "method": "GET",
      "path": "/open-api/order/purchase-order-infos",
      "risk": "R",
      "description": "Obtain purchase order information. This API is applicable to three store types: fully managed, SHEIN self-operated, and POP. It can be used to retrieve the purchase order list for the corresponding store and further query detailed information for each purchase order. Through this API, you can query two types of purchase orders: regular stock preparation orders and urgent purchase orders. Applicable application modes: 1, 2, 3, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002009",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "orderNos": {
                "type": "string",
                "description": "Purchase order number, supported in batches separated by ',', up to 200 purchase order numbers can be requested at a time"
              },
              "skcs": {
                "type": "string",
                "description": "skc list"
              },
              "type": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Purchase order type; 1: Urgent purchase/ 2: Stock"
              },
              "supplierCodes": {
                "type": "string",
                "description": "Merchant SKU array"
              },
              "combineTimeStart": {
                "type": "string",
                "description": "Stock or urgent purchase order dispatch time - start; Date format 2018-05-23 10:29:59; Query cannot exceed 60 days"
              },
              "combineTimeEnd": {
                "type": "string",
                "description": "Order sending time for stock orders or urgent purchase orders - end; Date format 2018-05-23 10:29:59; Query should not exceed 60 days"
              },
              "pageNumber": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "page number"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page size, maximum of 200 records"
              },
              "updateTimeStart": {
                "type": "string",
                "description": "Order update time for stock orders or urgent purchase orders - start; Date format 2018-05-23 10:29:59; Query should not exceed 60 days"
              },
              "updateTimeEnd": {
                "type": "string",
                "description": "Order update time for stock orders or urgent purchase orders - end; Date format 2018-05-23 10:29:59; Query should not exceed 60 days"
              },
              "selectJitMother": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Jit master order query identifier; 1: Return all purchase orders (including Jit master order)/ 2 or not specified: Return other purchase orders excluding Jit master order"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/shipping/basic": {
      "id": 3001981,
      "method": "GET",
      "path": "/open-api/shipping/basic",
      "risk": "R",
      "description": "Shipping basic information query interface. This interface retrieves shipping information such as the merchant's shipping address, shipping warehouse, supported shipping methods, packaging methods, shipping fleet, and shipping route. Querying SHEIN's partner logistics information requires calling [the API/library name - likely a link to a website called \"Query SHEIN Partner Logistics Products\"]. Applicable application modes: 1, 2, 3, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001981",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "orderType": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Order type, 1: Urgent purchase, 2: Stock preparation"
              },
              "addressId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Different shipping addresses can be matched with different courier services. If a shipping address is not selected, some logistics companies cannot match your shipment."
              },
              "orderNoList": {
                "type": "string",
                "description": "Order number list"
              },
              "includeSharedAddr": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Do you want to query shared shipping addresses? 1: Yes, 2: No, default is 1"
              }
            },
            "required": [
              "orderType"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/shipping/orderToShipping": {
      "id": 3002010,
      "method": "POST",
      "path": "/open-api/shipping/orderToShipping",
      "risk": "H",
      "description": "Create shipping order. Use this interface to create a shipping order and ship your orders. For fully managed order shipping, please refer to the Stock Order Fulfillment Management document. Applicable application modes: 1, 2, 3, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002010",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "adminName": {
                "type": "string",
                "description": "Username (can be defined by the ERP system; used by the system to record the operator of this shipment; not displayed on the page)"
              },
              "agedProductCode": {
                "type": "string",
                "description": "Logistics SLA product code, obtained from the Query SHEIN Partner Logistics Products API"
              },
              "list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "skuCode": {
                      "type": "string",
                      "description": "sku code, takes all SKUs in the input parameter of the purchase order"
                    },
                    "orderNo": {
                      "type": "string",
                      "description": "Order number"
                    },
                    "orderQuantity": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Order quantity"
                    },
                    "packageNum": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Number of packages (required when shipping; the same number of packages must be entered for the same order)"
                    },
                    "tempDeliveryQuantity": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Actual shipment quantity: If the quantity to be shipped is greater than 500, each shipment must contain more than 150."
                    },
                    "packingInfoList": {
                      "type": "object",
                      "properties": {
                        "packQuantity": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Quantity per carton"
                        },
                        "skuCode": {
                          "type": "string",
                          "description": "SKU code of the box"
                        }
                      },
                      "required": [
                        "packQuantity",
                        "skuCode"
                      ],
                      "additionalProperties": false,
                      "description": "Packing Detail, the Shipping Basic Information Query API requires Packing Detail when shippingRoute is 1 or 2; Packing Detail is not required when shippingRoute=0."
                    }
                  },
                  "required": [
                    "skuCode",
                    "orderNo",
                    "tempDeliveryQuantity"
                  ],
                  "additionalProperties": false
                }
              },
              "orderType": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Order type, 1: Urgent purchase, 2: Stock preparation"
              },
              "deliveryType": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "发货方式，商家可用的发货方式枚举值请从 发货基本信息查询获取； 全托管发货方式枚举值可以查看 备货单履约管理"
              },
              "arrivalTime": {
                "type": "string",
                "description": "Schedule SHEIN arrival time (yyyy-MM-dd HH:mm:ss), required when deliveryType=4 or 21"
              },
              "shippingRoute": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Shipping path, 0: Direct path, no Packing Detail required. 1: Direct path, Packing Detail required. 2: Consolidation path"
              },
              "expressId": {
                "type": "string",
                "description": "Carrier code, required when deliveryType=1. In the SHEIN integrated logistics scenario, obtain from the companyCode field of the Query SHEIN Partner Logistics Products API."
              },
              "coding": {
                "type": "string",
                "description": "Fleet code, required when deliveryType=2 and using Fleet for Shipping. Query from motorcadeId in the Shipping Basic Information Query API"
              },
              "expressInfo": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "addrId": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Shipping address ID, obtained from the Shipping Basic Information Query API"
                    },
                    "expressCode": {
                      "type": "string",
                      "description": "Track number, applicable to non-SHEIN integrated logistics scenarios"
                    },
                    "packageNumber": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Total number of packages (when using the box/mark type = total number of packages from all orders)"
                    },
                    "packageWeight": {
                      "type": "number",
                      "description": "Package weight (unit: kg)"
                    },
                    "reserveParcelTime": {
                      "type": "string",
                      "description": "Appointment pickup time (yyyy-MM-dd HH:mm:ss), required when deliveryType=1 and 2"
                    }
                  },
                  "required": [
                    "addrId",
                    "packageNumber"
                  ],
                  "additionalProperties": false,
                  "description": "Waymark Parcel Information"
                },
                "description": "Waymark Parcel Information"
              },
              "deliveryPackages": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "index": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Package serial numbers, starting from 0"
                    },
                    "packageHeight": {
                      "type": "number",
                      "description": "Package height (cm)"
                    },
                    "packageLength": {
                      "type": "number",
                      "description": "Package length (cm)"
                    },
                    "packageWeight": {
                      "type": "number",
                      "description": "Package weight (kg)"
                    },
                    "packageWidth": {
                      "type": "number",
                      "description": "Package width (cm)"
                    }
                  },
                  "required": [
                    "index"
                  ],
                  "additionalProperties": false,
                  "description": "List of package information. The length of the package list must match the number of packages. This is required only for shipments via INPOST logistics in Europe; package information is not required in other scenarios."
                },
                "description": "List of package information. The length of the package list must match the number of packages. This is required only for shipments via INPOST logistics in Europe; package information is not required in other scenarios."
              },
              "supplierWarehouseId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Merchant warehouse id"
              },
              "subWarehouseId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Supplier Subwarehouse ID"
              },
              "thirdPartyChannel": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Freight Forwarder channel, required when deliveryType = 2 and Shipping via Freight Forwarder is needed. Query from Query Freight Forwarder Information"
              },
              "thirdPartyChannelName": {
                "type": "string",
                "description": "Freight Forwarder channel name. This field is required when deliveryType = 2 and Shipping via a Freight Forwarder is needed. Query from Query Freight Forwarder Information ."
              },
              "thirdPartyOrderMethod": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Freight Forwarder order placement methods: 1. SHEIN places the order on behalf of the merchant; 2. The merchant places the order independently. This field is required when deliveryType = 2 and Shipping via a Freight Forwarder is needed."
              }
            },
            "required": [
              "adminName",
              "orderType",
              "deliveryType",
              "expressInfo",
              "supplierWarehouseId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/shipping/modify-delivery-order-info": {
      "id": 3001650,
      "method": "POST",
      "path": "/open-api/shipping/modify-delivery-order-info",
      "risk": "D",
      "description": "Modify and cancel shipping orders. Includes shipment cancellation as well as edits; both use the destructive lane. Applicable application modes: 1, 2, 3, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001650",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "addUid": {
                "type": "string",
                "description": "Operator, fill in as 'openapi' by default"
              },
              "deleteOrderNos": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Cancelled shipment order number"
                },
                "description": "Cancelled shipment order number"
              },
              "deliveryNo": {
                "type": "string",
                "description": "Shipping order number"
              },
              "list": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "deliveryQuantity": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Order quantity of goods"
                    },
                    "orderNo": {
                      "type": "string",
                      "description": "order number"
                    },
                    "packageNum": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "Order package quantity, only valid for type = box mark, please confirm the package type"
                    },
                    "skuCode": {
                      "type": "string",
                      "description": "sku encoding"
                    },
                    "packingInfoList": {
                      "type": "object",
                      "properties": {
                        "packQuantity": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991,
                          "description": "Packaging quantity, only applicable to overseas warehouse scenarios"
                        }
                      },
                      "required": [],
                      "additionalProperties": false,
                      "description": "Packaging details, only applicable to overseas warehouse scenarios"
                    }
                  },
                  "required": [],
                  "additionalProperties": false,
                  "description": "Transfer orders that are not deleted in the shipment order data here"
                },
                "description": "Transfer orders that are not deleted in the shipment order data here"
              },
              "packageNumber": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Total number of packages corresponding to the courier number"
              }
            },
            "required": [
              "addUid",
              "deliveryNo"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": true,
      "multipart": false
    },
    "GET /open-api/shipping/delivery": {
      "id": 3002045,
      "method": "GET",
      "path": "/open-api/shipping/delivery",
      "risk": "R",
      "description": "Query shipping order list. Query the list of shipping orders Applicable application modes: 1, 2, 3, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002045",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "deliveryCode": {
                "type": "string",
                "description": "Shipping Number"
              },
              "startTime": {
                "type": "string",
                "description": "Query by shipping order creation time，Date format yyyy-MM-dd HH:mm:ss"
              },
              "endTime": {
                "type": "string",
                "description": "Query by shipping order creation time，Date format yyyy-MM-dd HH:mm:ss"
              },
              "page": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page Number"
              },
              "perPage": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Number of pages per page, maximum 200"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/shipping/express-company-list-v2": {
      "id": 3001973,
      "method": "POST",
      "path": "/open-api/shipping/express-company-list-v2",
      "risk": "R",
      "description": "Query SHEIN’s partner logistics products. Use this interface to query the time-sensitive products and corresponding logistics companies offered by SHEIN's partner logistics services; Applicable application modes: 1, 2, 3, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001973",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "addressId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Shipping address ID, obtained from the interface"
              },
              "deliveryType": {
                "type": "string",
                "description": "Shipping method, fixed to 1"
              },
              "orderType": {
                "type": "string",
                "description": "Purchase Order Type 1: Urgent / 2: Stock"
              },
              "reserveParcelTime": {
                "type": "string",
                "description": "Reserve Pickup Time (yyyy-MM-dd HH:mm:ss)"
              },
              "purchaseOrders": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "orderNo": {
                      "type": "string",
                      "description": "Purchase Order No"
                    },
                    "skuInfos": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "qty": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Purchase Order Shipment Quantity"
                          },
                          "skuCode": {
                            "type": "string",
                            "description": "SHEIN sku code"
                          }
                        },
                        "required": [
                          "qty",
                          "skuCode"
                        ],
                        "additionalProperties": false,
                        "description": "Purchase Order Item Details"
                      },
                      "description": "Purchase Order Item Details"
                    }
                  },
                  "required": [
                    "orderNo",
                    "skuInfos"
                  ],
                  "additionalProperties": false,
                  "description": "Purchase Order Details"
                },
                "description": "Purchase Order Details"
              }
            },
            "required": [
              "addressId",
              "deliveryType",
              "orderType",
              "reserveParcelTime",
              "purchaseOrders"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/shipping/warehouse": {
      "id": 3001982,
      "method": "GET",
      "path": "/open-api/shipping/warehouse",
      "risk": "R",
      "description": "Receiving warehouse information query. This interface retrieves the platform's receiving warehouse address information for the inventory preparation order (applicable to fully managed and SHEIN self-operated models); Applicable application modes: 1, 2, 3, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001982",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "addressId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Obtain from Shipping Basic Information Query Interface ;"
              },
              "coding": {
                "type": "string",
                "description": "Fleet code"
              },
              "expressMode": {
                "type": "string",
                "description": "Express code"
              },
              "orderType": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Order type; 1: urgent purchase; 2: stocking up"
              },
              "sendType": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Shipping Method; Retrieved from Shipping Basic Information Query Interface ;"
              },
              "orderNoList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Purchase Order Number; Recommended to Fill Out, Will Affect Address Accuracy; Maximum Input of 200;"
                },
                "description": "Purchase Order Number; Recommended to Fill Out, Will Affect Address Accuracy; Maximum Input of 200;"
              },
              "shippingRoute": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Shipping route: 0 for direct delivery without packing details, 1 for direct delivery with packing details, and 2 for consolidation. Query via the Shipping Basic Information Query API ."
              }
            },
            "required": [
              "addressId",
              "orderType",
              "sendType"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/shipping/delivery/print-package": {
      "id": 3001293,
      "method": "POST",
      "path": "/open-api/shipping/delivery/print-package",
      "risk": "H",
      "description": "Shipping order dimension printing form. Use this API to obtain the logistics waybill information of the delivery order; Applicable application modes: 1, 2, 3, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001293",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "deliveryNo": {
                "type": "string",
                "description": "Shipping order number"
              }
            },
            "required": [
              "deliveryNo"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/idms/create-order": {
      "id": 3002040,
      "method": "POST",
      "path": "/open-api/idms/create-order",
      "risk": "H",
      "description": "Manually place stocking orders. This interface is used by merchants to create inventory preparation orders (created inventory preparation orders are subject to platform approval). It is applicable to some fully managed, self-operated, and semi-managed merchants. It's important to note that an inventory preparation order refers to SHEIN's purchase order to suppliers, not a customer order. To obtain customer-related order information, please use the order list interface: /open-api/order/order-list Applicable application modes: 1, 2, 3, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002040",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "paramList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "skc": {
                      "type": "string",
                      "description": "shein skc code"
                    },
                    "skuCodeList": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "skuCode": {
                            "type": "string",
                            "description": "shein sku code"
                          },
                          "orderCount": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "description": "Order quantity"
                          }
                        },
                        "required": [
                          "skuCode",
                          "orderCount"
                        ],
                        "additionalProperties": false,
                        "description": "Order parameters under sku"
                      },
                      "description": "Order parameters under sku"
                    }
                  },
                  "required": [
                    "skc",
                    "skuCodeList"
                  ],
                  "additionalProperties": false,
                  "description": "Order parameters"
                },
                "description": "Order parameters"
              }
            },
            "required": [
              "paramList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "void",
      "allow_absent_result": true,
      "multipart": false
    },
    "POST /open-api/idms/review-orders": {
      "id": 3002041,
      "method": "POST",
      "path": "/open-api/idms/review-orders",
      "risk": "R",
      "description": "Stocking order review list. This interface allows you to query the list of approved inventory preparation applications. It is applicable to merchants operating under a fully managed, self-operated or semi-managed model who prepare inventory at the Shein warehouse (SFS). Applicable application modes: 1, 2, 3, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002041",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skcList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "shein skc code"
                },
                "description": "shein skc code"
              },
              "supplierCodeList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Supplier or number"
                },
                "description": "Supplier or number"
              },
              "orderNoList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Stock order number"
                },
                "description": "Stock order number"
              },
              "addTimeBegin": {
                "type": "string",
                "description": "Start creation time"
              },
              "addTimeEnd": {
                "type": "string",
                "description": "Creation Time Ended"
              },
              "pageNum": {
                "type": "string",
                "description": "page number"
              },
              "pageSize": {
                "type": "string",
                "description": "Quantity per page"
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/msc/warehouse/list": {
      "id": 3002013,
      "method": "GET",
      "path": "/open-api/msc/warehouse/list",
      "risk": "R",
      "description": "Merchant warehouse list query. Function Introduction: Query merchant warehouse list information. Applicable Applications: Self-operated, Semi-managed ⚠️Note: If a merchant has multiple warehouses, the warehouse ID must be passed when modifying inventory. Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002013",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/stock/stock-query": {
      "id": 3001695,
      "method": "POST",
      "path": "/open-api/stock/stock-query",
      "risk": "R",
      "description": "Merchant inventory query API. Supports querying inventory quantity by sku, skc, and spu Request parameters: Please note that the three parameters skuCodeList/skcNameList/spuNameList cannot all be empty; at least one must be passed. invType is a new parameter used to more accurately represent the inventory type. The original warehouseType parameter will be deprecated on December 31, 2026. It is recommended to switch to invType as soon as possible. During the transition period, both parameters can be used simultaneously; when both are passed, invType will prevail. Applicable application modes: 1, 2, 3, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001695",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skuCodeList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SHEIN generate SKU, transmit with up to 100 items, skuCodeList/skcNameList/spuNameList, make sure only one of the three parameters is not empty;"
                },
                "description": "SHEIN generate SKU, transmit with up to 100 items, skuCodeList/skcNameList/spuNameList, make sure only one of the three parameters is not empty;"
              },
              "skcNameList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SHEIN generate SKC, skuCodeList/skcNameList/spuNameList, make sure only one of the three parameters is not empty;"
                },
                "description": "SHEIN generate SKC, skuCodeList/skcNameList/spuNameList, make sure only one of the three parameters is not empty;"
              },
              "spuNameList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SHEIN generate SPU, skuCodeList/skcNameList/spuNameList, make sure only one of the three parameters is not empty;"
                },
                "description": "SHEIN generate SPU, skuCodeList/skcNameList/spuNameList, make sure only one of the three parameters is not empty;"
              },
              "warehouseType": {
                "type": "string",
                "description": "Warehouse type; 1: Check preparation for SHEIN warehouse stock / 2: Check virtual stock for semi-managed, self-operated model / 3: Check virtual stock for subcontracted (fully managed), SHEIN-operated model"
              },
              "invType": {
                "type": "string",
                "description": "Inventory type，PI：SHEIN warehouse physical inventory，VI：seller virtual inventory，JI：seller JITJIT inventory"
              }
            },
            "required": [
              "warehouseType"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/gsp/goods/change-inventory": {
      "id": 3001692,
      "method": "POST",
      "path": "/open-api/gsp/goods/change-inventory",
      "risk": "H",
      "description": "Update merchant inventory API v1. Legacy merchant inventory API retires on 2026-12-31. Use v2 for new workflows. Inspect stock after acknowledgement. Applicable application modes: 1, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001692",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "updateSkuInventoryQuantityRequests": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "changeInventoryQuantity": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 2147483647,
                      "description": "Total inventory of the product; changeInventoryQuantity and saleInventory are required inputs, and only one can be filled;"
                    },
                    "skuCode": {
                      "type": "string",
                      "description": "SKUs generated by SHEIN platform, only approved SKUs can modify inventory; failed SKUs are not available"
                    },
                    "warehouseCode": {
                      "type": "string",
                      "description": "Warehouse ID, mandatory if the store has multiple warehouses. Can be viewed through the Seller Warehouse List Query API"
                    },
                    "saleInventory": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 2147483647,
                      "description": "Update saleable inventory; saleable inventory=available inventory+temporary lock inventory (order not paid); changeInventoryQuantity and saleInventory are required inputs, and only one can be filled;"
                    }
                  },
                  "required": [
                    "skuCode"
                  ],
                  "additionalProperties": false,
                  "description": "A single API call can transmit up to 100 SKUs. If the number of products requiring stock modification exceeds 100, developers need to make multiple API calls",
                  "oneOf": [
                    {
                      "required": [
                        "changeInventoryQuantity"
                      ],
                      "not": {
                        "required": [
                          "saleInventory"
                        ]
                      }
                    },
                    {
                      "required": [
                        "saleInventory"
                      ],
                      "not": {
                        "required": [
                          "changeInventoryQuantity"
                        ]
                      }
                    }
                  ]
                },
                "description": "A single API call can transmit up to 100 SKUs. If the number of products requiring stock modification exceeds 100, developers need to make multiple API calls",
                "minItems": 1,
                "maxItems": 100
              }
            },
            "required": [
              "updateSkuInventoryQuantityRequests"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/stock/change-inventory/v2": {
      "id": 3001738,
      "method": "POST",
      "path": "/open-api/stock/change-inventory/v2",
      "risk": "H",
      "description": "Update merchant inventory API v2. Only merchant VI/JI inventory. Inspect stock afterward: reserved/occupied stock can raise an overwritten total. Use distinct idempotency keys; never replay an uncertain change. Applicable application modes: 1, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001738",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "updateSkuInventoryQuantityRequests": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "idempotencyKey": {
                      "type": "string",
                      "description": "Business idempotent key. Duplicate requests will be deduplicated to avoid repeated inventory modifications.",
                      "minLength": 1
                    },
                    "skuCode": {
                      "type": "string",
                      "description": "SKUs generated by SHEIN platform, only approved SKUs can modify inventory; failed SKUs are not available",
                      "minLength": 1
                    },
                    "invType": {
                      "type": "string",
                      "description": "Inventory type VI：VIRTUAL_INVENTORY/virtual inventory； JI：JIT_INVENTORY/JIT virtual inventory；",
                      "enum": [
                        "VI",
                        "JI"
                      ]
                    },
                    "warehouseCode": {
                      "type": "string",
                      "description": "Modify merchant virtual inventory：merchant-owned warehouse code（required in multi-warehouse scenarios）。 Modify merchant JIT virtual inventory：no need to fill in。"
                    },
                    "changeType": {
                      "type": "string",
                      "description": "Total sales inventory = Available quantity + Reserved quantity + Occupied quantity. Reserved and occupied inventory are already occupied by consumer orders and cannot be modified. ADD: Increase inventory; SUB: Decrease inventory; Maximum reduction quantity = Available quantity, exceeding this range will report an error. OVERWRITE: Cover inventory; Covers total sales quantity = Available quantity + Reserved quantity + Occupied quantity, minimum coverage quantity cannot be lower than Reserved quantity + Occupied quantity, otherwise the inventory will be reduced by the Reserved quantity + Occupied quantity (i.e., only the corresponding unoccupied/reserved quantity can be subtracted).",
                      "enum": [
                        "ADD",
                        "SUB",
                        "OVERWRITE"
                      ]
                    },
                    "changeQuantity": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 2147483647,
                      "description": "Change quantity（positive number）"
                    },
                    "changeReason": {
                      "type": "string",
                      "description": "Change reason"
                    }
                  },
                  "required": [
                    "idempotencyKey",
                    "skuCode",
                    "invType",
                    "changeType",
                    "changeQuantity"
                  ],
                  "additionalProperties": false,
                  "description": "Up to 100 SKUs"
                },
                "description": "Up to 100 SKUs",
                "minItems": 1,
                "maxItems": 100
              }
            },
            "required": [
              "updateSkuInventoryQuantityRequests"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/goods/query-sku-sales": {
      "id": 3001305,
      "method": "POST",
      "path": "/open-api/goods/query-sku-sales",
      "risk": "R",
      "description": "Search sales by SKU. Merchants can query 7-day and 30-day sales through this interface The platform's QPS limit is 40/S, a large number of interface calls at a certain point in time may cause rate limiting The data of the interface is updated daily at 0:00 Beijing time, developers are advised to evenly pull data from 2:00 to 7:00 Beijing time Applicable application modes: 2, 3, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001305",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "skuCodeList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "skuCode, you can upload a maximum of 100 skuCodes"
                },
                "description": "skuCode, you can upload a maximum of 100 skuCodes"
              }
            },
            "required": [
              "skuCodeList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/campaigns/campaign-list": {
      "id": 3001993,
      "method": "POST",
      "path": "/open-api/campaigns/campaign-list",
      "risk": "R",
      "description": "Query Available Campaign List. This interface retrieves all marketing activities that merchants can register for, and supports filtering by activity type. Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001993",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number (starting from 1)"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Quantity per page (max 100)"
              },
              "activityIdList": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Campaign ID (up to 100)"
                },
                "description": "Campaign ID (up to 100)"
              },
              "activityTypeList": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Activity Type (1: Channel; 2: Clearance; 3: Major Promotion; 4: Daily)"
                },
                "description": "Activity Type (1: Channel; 2: Clearance; 3: Major Promotion; 4: Daily)"
              }
            },
            "required": [
              "pageNum",
              "pageSize"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/campaigns/campaign-detail": {
      "id": 3002006,
      "method": "POST",
      "path": "/open-api/campaigns/campaign-detail",
      "risk": "R",
      "description": "Query campaign details. Retrieve marketing campaign details via API, including campaign dates, participating sites, registration methods, and requirements for stores and products. Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002006",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "activityId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Campaign ID"
              }
            },
            "required": [
              "activityId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/campaigns/registrable-product-list": {
      "id": 3002014,
      "method": "POST",
      "path": "/open-api/campaigns/registrable-product-list",
      "risk": "R",
      "description": "Query list of products eligible for campaign registration. Query the products that merchants can register for in a specified event and the registration requirements, including the event price or discount range, the required number of items, and the required number of reserved items. For self-operated models, pay attention to the selling price related fields; for semi-managed and fully managed models, pay attention to the supply price related fields. Inventory related fields are all SKC-level; price related fields support both SKC and SKU levels, and the specific dimension used needs to be determined based on the partakeScope returned by the Query Event Details API . Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002014",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number, starting from 1。"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Quantity per page, maximum 100."
              },
              "activityId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Campaign ID"
              },
              "skcList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC, up to 100."
                },
                "description": "SKC, up to 100."
              }
            },
            "required": [
              "pageNum",
              "pageSize",
              "activityId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/campaigns/register-campaign": {
      "id": 3002032,
      "method": "POST",
      "path": "/open-api/campaigns/register-campaign",
      "risk": "H",
      "description": "Sign up for campaign. This API is used to submit product registrations for a campaign. Before calling it, you need to obtain the registration rules and submission requirements through the Query Campaign Details API and the Query Campaign Eligible Product List API . Summary of Submission Rules: 1. Basic Required Information The fields to be filled in are subject to the partakeFieldList returned by the campaign details API (common fields include: campaign price, campaign quantity, and campaign reserved quantity). 2. Campaign Price Submission Submission dimension: The partakeScope returned by the campaign details API determines whether pricing is submitted by SKC or SKU. If it is at the SKU level and isMultiSize=0 , the campaign prices of all SKUs under the same SKC must be consistent. Quotation format and range: The adjustForm returned by the campaign details API determines the quotation method (whether to submit the campaign price or the discount rate), while the siteRuleInfoList returned by the campaign eligible product list API provides the allowed range for the price or discount rate. Parameter fields: Self-operated merchants (priced based on selling price) submit through siteInfoList in the campaign registration API; semi-managed/fully managed merchants (priced based on supply price) submit through supplyPriceInfo . 3. Campaign Quantity and Reserved Quantity Both must be submitted at the SKC level. Campaign quantity: The maximum quantity of the SKC that can be sold at the campaign price during the campaign period. Campaign reserved quantity: The minimum inventory quantity that must be reserved for the SKC during the campaign period. 4. Site Registration Requirements Use supportSelectSitePartake from the campaign details API to determine whether registration for selected sites is supported. If selected-site registration is supported: Self-operated merchants need to submit prices in the corresponding currencies by site through siteInfoList in the campaign registration API; semi-managed/fully managed merchants need to submit the registration sites through siteList . Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002032",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "activityId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Campaign ID"
              },
              "goodsInfoList": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "skc": {
                      "type": "string",
                      "description": "SKC code"
                    },
                    "actStock": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "活动件数按SKC维度提报。 先查询活动详情接口，若 partakeFieldList 包含2，则活动件数必传。再通过活动可报商品列表接口获取 minActStockNum 、 maxActStockNum 和 stock ，活动件数需在 minActStockNum 和 maxActStockNum 区间内，且不大于 stock 。"
                    },
                    "reserveStock": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991,
                      "description": "活动预留件数按SKC维度提报。 先查询活动详情接口，若 partakeFieldList 包含3，则活动预留件数必传。再通过活动可报商品列表接口获取 minReserveStockNum 和 stock ，活动预留件数需不小于 minReserveStockNum ，且不大于 stock 。"
                    },
                    "supplyPriceInfo": {
                      "type": "object",
                      "properties": {
                        "siteList": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "description": "Site, e.g., shein-br. First query the activity details API: when supportSelectSitePartake=1 , this field is required, and its value must come from the siteList returned by the API; when supportSelectSitePartake=0 , this field does not need to be passed."
                          },
                          "description": "Site, e.g., shein-br. First query the activity details API: when supportSelectSitePartake=1 , this field is required, and its value must come from the siteList returned by the API; when supportSelectSitePartake=0 , this field does not need to be passed."
                        },
                        "enrollCurrency": {
                          "type": "string",
                          "description": "The currency of the supply price under the semi-managed/fully-managed model, for example: BRL. The value can be obtained from the supplyPriceCurrency returned by the query activity details API."
                        },
                        "enrollCostPrice": {
                          "type": "string",
                          "description": "Submit the activity supply price by SKC dimension. The calculation formula is: Activity Supply Price = Supply Price * (1 - Supply Price Reduction Rate). The SKC supply price can be obtained via the query interface for the list of products eligible for the activity. For the supply price reduction rate, refer to fields such as minSupplyPriceRate , maxSupplyPriceRate , minVipSupplyPriceRate , maxVipSupplyPriceRate , and minSvipSupplyPriceRate returned by this interface, and select any one of the supported reduction tiers for submission. Typically, values can be entered up to two decimal places; however, if the supply price currency is JPY, only integers are supported."
                        }
                      },
                      "required": [
                        "enrollCurrency",
                        "enrollCostPrice"
                      ],
                      "additionalProperties": false,
                      "description": "In semi-managed or fully managed modes, if the activity details API returns partakeScope=0 , you must submit activity prices by SKC dimension using this field."
                    },
                    "siteInfoList": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "site": {
                            "type": "string",
                            "description": "Site, example: shein-br. The field value must be taken from the siteList returned by the activity details API."
                          },
                          "enrollCurrency": {
                            "type": "string",
                            "description": "The currency corresponding to the site site , for example: BRL. It can be obtained from the sellPriceSiteInfoList field returned by the query activity details API."
                          },
                          "enrollPrice": {
                            "type": "string",
                            "description": "按SKC维度提报活动售价。需先调用查询活动详情接口确认报价形式：当 adjustForm=1 时，需传入本字段。 活动售价需依据查询活动可报商品列表接口返回的 siteRuleInfoList 计算并校验： 1. 若返回建议活动价区间 minSuggestPrice 、 maxSuggestPrice ，则活动售价须在该区间内； 2. 若返回售价降幅区间 minSalePriceRate 、 maxSalePriceRate ，则需在该区间内选择降幅进行提报，计算公式为：活动售价=售价×(1-售价降幅)。其中，SKC售价可通过查询活动可报商品列表接口获取。 通常价格最多保留两位小数；若币种为日元，仅支持填写整数。"
                          },
                          "enrollSalePriceRate": {
                            "type": "string",
                            "description": "Report the selling price reduction by SKC dimension. First, call the query activity details API to confirm the quotation format: this field must be passed when adjustForm=6 . The reportable range for the selling price reduction can be obtained from the minSalePriceRate and maxSalePriceRate fields returned by the query activity reportable product list API."
                          }
                        },
                        "required": [
                          "site"
                        ],
                        "additionalProperties": false,
                        "description": "自运营模式下，若活动详情接口返回 partakeScope=0 ，需通过本字段按站点提报SKC维度的活动价格。 其中，若 supportSelectSitePartake=0 ，则需为 siteList 中全部站点提报活动价格；若 supportSelectSitePartake=1 ，则可选择 siteList 中的部分站点提报。"
                      },
                      "description": "自运营模式下，若活动详情接口返回 partakeScope=0 ，需通过本字段按站点提报SKC维度的活动价格。 其中，若 supportSelectSitePartake=0 ，则需为 siteList 中全部站点提报活动价格；若 supportSelectSitePartake=1 ，则可选择 siteList 中的部分站点提报。"
                    },
                    "skuInfoList": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "sku": {
                            "type": "string",
                            "description": "SKU Code"
                          },
                          "supplyPriceInfo": {
                            "type": "object",
                            "properties": {
                              "siteList": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "description": "站点，示例：shein-br。 先查询活动详情接口：当 supportSelectSitePartake=1 时，本字段必传，且取值必须来自接口返回的 siteList ；当 supportSelectSitePartake=0 时，无需传入本字段。"
                                },
                                "description": "站点，示例：shein-br。 先查询活动详情接口：当 supportSelectSitePartake=1 时，本字段必传，且取值必须来自接口返回的 siteList ；当 supportSelectSitePartake=0 时，无需传入本字段。"
                              },
                              "enrollCurrency": {
                                "type": "string",
                                "description": "The currency of the supply price under the semi-managed or fully-managed model, for example: BRL. The value can be obtained from the supplyPriceCurrency returned by the query activity details API."
                              },
                              "enrollCostPrice": {
                                "type": "string",
                                "description": "Submit the promotional supply price by SKU dimension. The calculation formula is: Promotional Supply Price = Supply Price * (1 - Supply Price Reduction Rate). The SKU supply price can be obtained by querying the interface for the list of products eligible for the promotion. The supply price reduction rate should refer to fields such as minSupplyPriceRate , maxSupplyPriceRate , minVipSupplyPriceRate , maxVipSupplyPriceRate , and minSvipSupplyPriceRate returned by this interface. You may select any one of the supported reduction rate tiers for submission. Typically, values can be entered up to two decimal places; however, if the supply price currency is JPY, only integers are supported."
                              }
                            },
                            "required": [
                              "enrollCurrency",
                              "enrollCostPrice"
                            ],
                            "additionalProperties": false,
                            "description": "Under the semi-managed or fully-managed model, if the activity details API returns partakeScope=1 , you must submit the activity price by SKU dimension using this field."
                          },
                          "siteInfoList": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "site": {
                                  "type": "string",
                                  "description": "Site, e.g., shein-br. The field value must be obtained from the siteList returned by the activity details API."
                                },
                                "enrollCurrency": {
                                  "type": "string",
                                  "description": "Currency corresponding to the site site , example: BRL. Can be obtained from the sellPriceSiteInfoList field returned by the query activity details API."
                                },
                                "enrollPrice": {
                                  "type": "string",
                                  "description": "按SKU维度提报活动售价。需先调用查询活动详情接口确认报价形式：当 adjustForm=1 时，需传入本字段。 活动售价需依据查询活动可报商品列表接口返回的 siteRuleInfoList 计算并校验： 1. 若返回建议活动价区间 minSuggestPrice 、 maxSuggestPrice ，则活动售价须在该区间内； 2. 若返回售价降幅区间 minSalePriceRate 、 maxSalePriceRate ，则需在该区间内选择降幅进行提报，计算公式为：活动售价=售价×(1-售价降幅)。其中，SKU售价可通过查询活动可报商品列表接口获取。 通常价格最多保留两位小数；若币种为日元，仅支持填写整数。"
                                },
                                "enrollSalePriceRate": {
                                  "type": "string",
                                  "description": "Submit the selling price reduction by SKU dimension. First, call the query activity details API to confirm the quotation format: this field must be passed when adjustForm=6 . The allowable range for the selling price reduction can be obtained from the minSalePriceRate and maxSalePriceRate fields returned by the query activity reportable product list API."
                                }
                              },
                              "required": [
                                "site"
                              ],
                              "additionalProperties": false,
                              "description": "自运营模式下，若活动详情接口返回 partakeScope=1 ，需通过本字段按站点提报SKU维度的活动价格。 其中，若 supportSelectSitePartake=0 ，则需为 siteList 中全部站点提报活动价格；若 supportSelectSitePartake=1 ，则可选择 siteList 中的部分站点提报。"
                            },
                            "description": "自运营模式下，若活动详情接口返回 partakeScope=1 ，需通过本字段按站点提报SKU维度的活动价格。 其中，若 supportSelectSitePartake=0 ，则需为 siteList 中全部站点提报活动价格；若 supportSelectSitePartake=1 ，则可选择 siteList 中的部分站点提报。"
                          }
                        },
                        "required": [
                          "sku"
                        ],
                        "additionalProperties": false,
                        "description": "When the activity details API returns partakeScope=1 , you must submit activity prices by SKU dimension using this array."
                      },
                      "description": "When the activity details API returns partakeScope=1 , you must submit activity prices by SKU dimension using this array."
                    }
                  },
                  "required": [
                    "skc"
                  ],
                  "additionalProperties": false,
                  "description": "Submit product information, up to 100 items."
                },
                "description": "Submit product information, up to 100 items."
              }
            },
            "required": [
              "activityId",
              "goodsInfoList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/campaigns/registration-records": {
      "id": 3002016,
      "method": "POST",
      "path": "/open-api/campaigns/registration-records",
      "risk": "R",
      "description": "Query campaign registration record list. This interface is used to query marketing campaign registration records. It supports filtering by campaign ID and SKC, and only supports querying registration records from the past 6 months. Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3002016",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "pageNum": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number (starting from 1)"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Quantity per page (max 100)"
              },
              "activityIdList": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Campaign ID (up to 100)"
                },
                "description": "Campaign ID (up to 100)"
              },
              "skcList": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "SKC（up to 100）"
                },
                "description": "SKC（up to 100）"
              }
            },
            "required": [
              "pageNum",
              "pageSize"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/campaigns/cancel-registration": {
      "id": 3001998,
      "method": "POST",
      "path": "/open-api/campaigns/cancel-registration",
      "risk": "D",
      "description": "Cancel campaign registration. This API is used to cancel registration for a marketing campaign. Cancellation is allowed when the registration status is \"Under Review\". Applicable application modes: 1, 2, 5, 8. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001998",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "partakeGoodsIdList": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Registration record IDs (up to 100). Can be obtained via the query registration record list API."
                },
                "description": "Registration record IDs (up to 100). Can be obtained via the query registration record list API."
              }
            },
            "required": [
              "partakeGoodsIdList"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/finance/report-order-list": {
      "id": 3001920,
      "method": "POST",
      "path": "/open-api/finance/report-order-list",
      "risk": "R",
      "description": "Query the list of invoices. Self-operated and semi-managed applications can use this interface to query the list of generated invoices in the store. Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001920",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "page": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Current page"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Number of records per page"
              },
              "reportOrderNo": {
                "type": "string",
                "description": "Invoice number"
              },
              "reportStatus": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Invoice status: 1 - Payment imminent, 2 - Payment completed, 3 - Payment error"
              },
              "completedPayDate": {
                "type": "string",
                "description": "Payment week, format: yyyy-MM-dd, enter any day of the week (this will override the payment completion time)."
              },
              "completedPayTimeStart": {
                "type": "string",
                "description": "Payment completion time, format: yyyy-MM-ddHH:mm:ss"
              },
              "completedPayTimeEnd": {
                "type": "string",
                "description": "打款完成开始时间，格式：yyyy-MM-ddHH:mm:ss"
              }
            },
            "required": [
              "page",
              "pageSize"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/finance/get-check-order-list": {
      "id": 3001631,
      "method": "POST",
      "path": "/open-api/finance/get-check-order-list",
      "risk": "R",
      "description": "Query statement list. Self-operated and semi-managed applications can use this interface to query the list of generated account statements in the store. Currently, only self-operated and semi-managed stores are supported for the account statement list. Account Statement Interface Description: When an order or other business document enters the settlement node, the system will generate the corresponding account statement. After the account statement is generated for a period of time, the platform will make the payment, at which time a report form will be generated. A report form usually contains multiple account statements involved in the same batch of payments. Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001631",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "bzOrderNos": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Business order number, generally refers to the order number, supports querying up to 100 at a time"
                },
                "description": "Business order number, generally refers to the order number, supports querying up to 100 at a time"
              },
              "checkStatus": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Reconciliation statement status:1-Pending settlement, 2-In settlement, 3-Settled, 4-Settlement exception"
              },
              "endAddTime": {
                "type": "string",
                "description": "Query by reconciliation statement generation time, end time of query period, format: yyyy-MM-dd HH:mm:ss"
              },
              "endEstimatePayTime": {
                "type": "string",
                "description": "Estimated payment date end time, format: yyyy-MM-dd HH:mm:ss"
              },
              "extendOrderNos": {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "Other business order numbers, such as return orders, penalty orders, supports querying up to 100 at a time"
                },
                "description": "Other business order numbers, such as return orders, penalty orders, supports querying up to 100 at a time"
              },
              "page": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Current page"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Records per page, up to 30 entries"
              },
              "reportOrderNos": {
                "type": "string",
                "description": "List of billing numbers (maximum 100)"
              },
              "secondOrderTypes": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991,
                  "description": "Secondary bill type, click to view specific enumeration values FAQ"
                },
                "description": "Secondary bill type, click to view specific enumeration values FAQ"
              },
              "startAddTime": {
                "type": "string",
                "description": "Query by reconciliation statement generation time, start time of query period, format: yyyy-MM-dd HH:mm:ss"
              },
              "startEstimatePayTime": {
                "type": "string",
                "description": "Estimated payment date start time, format: yyyy-MM-dd HH:mm:ss"
              }
            },
            "required": [
              "endAddTime",
              "page",
              "pageSize",
              "startAddTime"
            ],
            "additionalProperties": false,
            "description": "Expense detail request Model"
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/finance/get-check-order-detail": {
      "id": 3001932,
      "method": "GET",
      "path": "/open-api/finance/get-check-order-detail",
      "risk": "R",
      "description": "Query statement details. Applications operating in a self-managed or semi-managed model are available. Statement details can be queried using the statement number, which can be obtained through the Statement List Query API . Applicable application modes: 1, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001932",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "checkOrderNo": {
                "type": "string",
                "description": "Reconciliation number, can be obtained through the Query Reconciliation List API . Please note, this API is a GET request."
              }
            },
            "required": [
              "checkOrderNo"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/openapi-business-backend/query-store-info": {
      "id": 3001499,
      "method": "POST",
      "path": "/open-api/openapi-business-backend/query-store-info",
      "risk": "R",
      "description": "Query store information. Query basic store information, such as merchant ID, store status, and the number of products the store can publish Applicable application modes: 1, 2, 5, 8. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001499",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false,
            "description": "storeInfoRequest"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/ssls/announcement/get-anno-list": {
      "id": 3001144,
      "method": "POST",
      "path": "/open-api/ssls/announcement/get-anno-list",
      "risk": "R",
      "description": "Query announcement list. Get the announcement list Applicable application modes: not specified by this public reference; provider permission is authoritative. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001144",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "pageNumber": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Page number"
              },
              "pageSize": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Number of items returned per page; Please set an integer between 1 and 30"
              }
            },
            "required": [],
            "additionalProperties": false,
            "description": "req"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/ssls/announcement/get-anno-detail": {
      "id": 3001145,
      "method": "POST",
      "path": "/open-api/ssls/announcement/get-anno-detail",
      "risk": "R",
      "description": "Get announcement details. Get announcement details Applicable application modes: not specified by this public reference; provider permission is authoritative. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001145",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "announcementId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991,
                "description": "Announcement ID"
              }
            },
            "required": [],
            "additionalProperties": false,
            "description": "req"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "response_field": "info",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/ccst/v1/custom-infos": {
      "id": 3001668,
      "method": "GET",
      "path": "/open-api/ccst/v1/custom-infos",
      "risk": "R",
      "description": "Get customized data. Query customized data using the customized product ID (customInfoId) Applicable application modes: 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001668",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "customInfoId": {
                "type": "string",
                "description": "Unique identifier for user-customized information"
              },
              "lang": {
                "type": "string",
                "description": "语种输入，影响label字段的语种输出；枚举：英语(美国) en_US , 德语 de_DE , 法语 fr_FR , 葡萄牙语(巴西) pt_BR , 西班牙语 es_ES , 日语 ja_JP , 意大利语 it_IT , 荷兰语 nl_NL , 繁体中文 zh_TW , 简体中文 zh_CN , 希伯来语(以色列) he_IL , 俄语 ru_RU , 阿拉伯语 ar_AR , 泰语 th_TH , 印度尼西亚语 id_ID , 土耳其语 tr_TR , 越南语 vi_VI , 瑞典语 sv_SV , 波兰语 pl_PL , 葡萄牙语 pt_PT , 韩语 ko_KR , 希腊语 el_GR , 捷克语 cs_CZ , 罗马尼亚语 ro_RO , 斯洛伐克语 sk_SK , 匈牙利语 hu_HU , 保加利亚语 bg_BG"
              }
            },
            "required": [
              "customInfoId",
              "lang"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "response_field": "data",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/ccst/v1/composite/task": {
      "id": 3001672,
      "method": "POST",
      "path": "/open-api/ccst/v1/composite/task",
      "risk": "W",
      "description": "Create production template task. Use the customized product ID (customInfoId) + template ID (compositeId) to generate the final customized production task. Asynchronous query results are required. Applicable application modes: 2, 5. Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001672",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "compositeId": {
                "type": "string",
                "description": "The order template ID is used to synthesize production images"
              },
              "customInfoId": {
                "type": "string",
                "description": "Customized data ID, the unique identifier of user-customized data"
              },
              "needUpdate": {
                "type": "boolean",
                "description": "Whether to use the updated compositeId, if true is passed, the latest value is returned, if false is passed, the value when the user added to the cart is returned. Default is false."
              }
            },
            "required": [
              "compositeId",
              "customInfoId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "data",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/ccst/v1/custom-info/templates": {
      "id": 3001670,
      "method": "GET",
      "path": "/open-api/ccst/v1/custom-info/templates",
      "risk": "R",
      "description": "Get template data. Successful API request communication uniformly returns HTTP code 200 Return body code error code descriptions: 100001: The CustomInfoId field is a required field 120001: Template data not found 120002: Merchant ID does not match 130002: This IP has reached the 60-times-per-minute limit 100002: Request exception 9999: Unknown system error Applicable application modes: 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001670",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "customInfoId": {
                "type": "string",
                "description": "Customized data ID, obtained from purchase order information"
              },
              "needUpdate": {
                "type": "string",
                "description": "Do you want to use the updated value, if true is passed, it returns the latest value, if false is passed, it returns the value when the user added to the cart。Default is false。"
              }
            },
            "required": [
              "customInfoId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "response_field": "data",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "GET /open-api/ccst/v1/composite/queryTask": {
      "id": 3001671,
      "method": "GET",
      "path": "/open-api/ccst/v1/composite/queryTask",
      "risk": "R",
      "description": "Query task results. Successful API request communication uniformly returns HTTP code 200 Return body code error code descriptions: 100004: Id field is required 120002: Merchant ID does not match 100008: Task not found 130002: This IP has reached the 60-times-per-minute limit 100002: Request exception 9999: Unknown system error Applicable application modes: 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001671",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "Get id from endpoint /ccst/openapi/v1/composite/task"
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
        "additionalProperties": false
      },
      "response_field": "data",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    },
    "POST /open-api/ccst/v1/custom-info/queryAddCartInfo": {
      "id": 3001665,
      "method": "POST",
      "path": "/open-api/ccst/v1/custom-info/queryAddCartInfo",
      "risk": "R",
      "description": "Query Add-to-Cart Structure Information.  Applicable application modes: 2, 5. Reference: https://open.sheincorp.com/documents/apidoc/detail/3001665",
      "input_schema": {
        "type": "object",
        "properties": {
          "body": {
            "type": "object",
            "properties": {
              "customId": {
                "type": "string",
                "description": "Custom build ID"
              }
            },
            "required": [
              "customId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "body"
        ],
        "additionalProperties": false
      },
      "response_field": "data",
      "result_type": "object",
      "allow_absent_result": false,
      "multipart": false
    }
  },
  "host_owned_methods": {
    "3001226": "Signed Feed document download grants belong to the host document workflow.",
    "3001227": "The public definition does not establish the Feed content request schema or consistent document query name.",
    "3001229": "Feed document creation/upload/download requires a bounded host document workflow.",
    "3001520": "Credential exchange belongs to seller authorization."
  },
  "other_application_methods": [
    "POST /open-api/goods/batch-skc-size",
    "GET /open-api/goods/number-list",
    "GET /open-api/order/get-mothe-child-orders",
    "POST /open-api/purchase/intelligent-packing-result",
    "POST /open-api/openapi-business-backend/purchase-estimated-fee",
    "POST /open-api/pfmp/shipping/thirdPartyAndChannelList",
    "POST /open-api/pfmp/print-purchase-logisticsLabel",
    "POST /open-api/goods/print-barcode",
    "POST /open-api/openapi-business-backend/stock-goods-list",
    "POST /open-api/order/print-package",
    "GET /open-api/shipping/express-company-list",
    "GET /open-api/order/storage-receiver-info",
    "POST /open-api/purchase/return-application-list",
    "POST /open-api/purchase/return-application-detail",
    "GET /open-api/purchase/return-disposals",
    "POST /open-api/purchase/return-pickup-methods",
    "POST /open-api/purchase/query-return-address",
    "POST /open-api/purchase/return-carriers",
    "POST /open-api/purchase/confirm-return-application",
    "POST /open-api/purchase/returnable-inventory",
    "POST /open-api/purchase/create-return-application",
    "POST /open-api/purchase/return-list",
    "POST /open-api/purchase/return-product-detail",
    "POST /open-api/purchase/return-package-detail",
    "POST /open-api/purchase/update-pickup-methods",
    "POST /open-api/goods/stock-update",
    "POST /open-api/finance/report-list",
    "POST /open-api/finance/report-sales-detail",
    "POST /open-api/finance/report-adjustment-detail",
    "POST /open-api/order/openapi/auth/order/express-upload",
    "POST /open-api/order/openapi/auth/order/outbound-result",
    "POST /open-api/order/openapi/auth/order/outbound-cancel",
    "POST /open-api/lsps-java/auth/entity-change",
    "POST /open-api/cargo/express-website-message",
    "POST /open-api/cargo/logistics-trajectory-callback",
    "POST /open-api/cargo/platenum-callback",
    "POST /open-api/cargo/qc-outside-cancel-sf-express",
    "POST /open-api/cargo/weight-callback",
    "GET /open-api/order/express-infos",
    "POST /open-api/cargo/express-notify",
    "POST /open-api/cargo/track-notify",
    "POST /open-api/cargo/track-notify-trackingmore",
    "POST /open-api/cargo/quote-return",
    "POST /open-api/cargo/timeout-cancel-reason-return",
    "POST /open-api/mes/get-purchase-info",
    "POST /open-api/mes/get-material-info",
    "POST /open-api/mes/get-second-precess",
    "POST /open-api/mes/get-big-goods-bom",
    "POST /open-api/mes/bundle-info",
    "POST /open-api/mes/material-anomalous/list",
    "POST /open-api/mes/purchase-detail-info-list",
    "POST /open-api/mes/query-produce-order-ids",
    "POST /open-api/mes/deliver-order/list",
    "POST /open-api/mes/order-inventory-surplus/list",
    "POST /open-api/mes/get-produce-order-info",
    "POST /open-api/mes/get-order-info",
    "POST /open-api/mes/order-inventory-surplus/update",
    "POST /open-api/mes/sew-end",
    "POST /open-api/mes/end-cut-bed",
    "POST /open-api/mes/query-produce-order-info-by-id",
    "POST /open-api/sims/stock-update",
    "POST /open-api/sims/inbound-order-confirm",
    "POST /open-api/sims/inbound-order-modify",
    "POST /open-api/spss/skc-page-query",
    "POST /open-api/spss/skc-info-query",
    "POST /open-api/sims/inbound-order-query",
    "POST /open-api/sims/outbound-order-query",
    "POST /open-api/sims/stock-query",
    "POST /open-api/sims/location-query",
    "POST /open-api/sims/srp/progress-node-query",
    "POST /open-api/sims/srp/timeline-query",
    "POST /open-api/sims/srp/procedure-query",
    "POST /open-api/sims/srp/production-plan-query",
    "POST /open-api/sims/srp/task-query",
    "POST /open-api/sims/srp/tasks-create-by-production-nos",
    "POST /open-api/sims/srp/sfp-tasks-create-by-production-nos",
    "POST /open-api/sims/srp/tasks-create-by-products",
    "POST /open-api/sims/srp/sfp-tasks-create-by-sfps",
    "POST /open-api/sims/srp/task-update",
    "POST /open-api/material/in-inventory",
    "POST /open-api/material/out-inventory",
    "POST /open-api/material/receive-cloth-report",
    "POST /open-api/material/sales-order-deliver-info",
    "POST /open-api/material/sync-inventory",
    "POST /open-api/material/mesCreateAddSupp",
    "POST /open-api/mdp/get-order-info-list",
    "POST /open-api/mdp/product/print-task/begin",
    "POST /open-api/mdp/product/print-task/finish",
    "POST /open-api/mdp/product/schedule/allocation-confirm",
    "POST /open-api/mdp/product/transfer-print-task/begin",
    "POST /open-api/mdp/product/transfer-print-task/finish",
    "POST /open-api/mdp/order/customer-requirement/create-customer-requirement",
    "POST /open-api/mdp/order/customer-requirement/get-factory-customer-list",
    "POST /open-api/mdp/order/customer-requirement/get-factory-list",
    "POST /open-api/mdp/order/goods/reenter-order-info",
    "POST /open-api/mdp/order/goods/sync-order-info",
    "POST /open-api/mdp/wx-mini-program/login",
    "POST /open-api/mdp/hangcard/operate",
    "POST /open-api/mdp/hang-card/add-or-update",
    "POST /open-api/mdp/basic-configure/production-equipment/get-print-equipmentList",
    "POST /open-api/mdp/basic-configure/production-equipment/add-or-cancel-equipment-exception",
    "POST /open-api/mdp/order/goods/external/receive-external-erp-complete-order",
    "POST /open-api/mdp/process/get-process-develop-info-list",
    "POST /open-api/mdp/order/external/get-order-log-list",
    "POST /open-api/mdp/flower/get-pattern-dev-page-list",
    "POST /open-api/mdp/process/pushProcessFileUrl",
    "POST /open-api/mdp/process/getPushProcessSts"
  ]
};
