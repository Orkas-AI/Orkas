'use strict';
// Generated offline from the pinned public Qoo10 Japan guide.
module.exports = {
  "methods": {
    "ItemsBasic.SetNewGoods": {
      "id": 10009,
      "version": "1.1",
      "risk": "H",
      "description": "Create a product",
      "input_schema": {
        "type": "object",
        "properties": {
          "SecondSubCat": {
            "type": "string",
            "description": "This the category code of Qoo10 where the item will be registered.\n* You can download the information of Qoo10's Categories in the \"Bulk-data management\" menu at the QSM.\n(ex.300000001)\nOfficial example: 300000001",
            "maxLength": 9,
            "minLength": 1
          },
          "OuterSecondSubCat": {
            "type": "string",
            "description": "This is the external category code that the sellers use on their own.\nOfficial example: 10000001",
            "maxLength": 20
          },
          "Drugtype": {
            "type": "string",
            "description": "If the Item is in Medicine Category, this field is a requirement.\n(1C : Class 1 OTC drugs, 2C : Class 2 OTC drugs, 3C : Class 3 OTC drugs, D2 : Designated Class 2 OTC drugs, QD : Quasi-drugs)\nOfficial example: 1C",
            "maxLength": 2
          },
          "BrandNo": {
            "type": "string",
            "description": "This is the brand code that is registered in Qoo10. You can request to register new brand in the QSM.\nOfficial example: 100550",
            "maxLength": 10
          },
          "ItemTitle": {
            "type": "string",
            "description": "Item Title",
            "maxLength": 100,
            "minLength": 1
          },
          "PromotionName": {
            "type": "string",
            "description": "Item Title for Promotion",
            "maxLength": 20
          },
          "SellerCode": {
            "type": "string",
            "description": "Seller Item Code : This is the item code managed by the seller. This  value is the  key value to edit the information such as a price etc. later.\nOfficial example: A12345b",
            "maxLength": 100
          },
          "IndustrialCodeType": {
            "type": "string",
            "description": "Industrial Code Type\nOfficial example: J",
            "maxLength": 1
          },
          "IndustrialCode": {
            "type": "string",
            "description": "This is the Industrial Code such as JAN Code or ISBN etc.\nIf you fill in the standard code, the item would be exposed in the price comparison sites.\nOfficial example: TK-FBP019EBK",
            "maxLength": 13
          },
          "ModelNM": {
            "type": "string",
            "description": "Product Code\nOfficial example: CUH-7218BB01",
            "maxLength": 30
          },
          "ManufactureDate": {
            "type": "string",
            "description": "Manufactured Date(YYYY-MM-DD)\nOfficial example: 2025-01-01",
            "maxLength": 10
          },
          "ProductionPlaceType": {
            "type": "string",
            "description": "Product Origin type (Domestic=1, Imported=2, etc=3)\n*Depending on the type, you can enter different values for the origin (ProductionPlace)\nIn etc, please enter \"ProductionPlaceType\" correctly. *Validity check\nOfficial example: 1",
            "maxLength": 1
          },
          "ProductionPlace": {
            "type": "string",
            "description": "Information of the country of origin, or place of origin.\nType1: TOKYO * Write the names of the prefectures in Roman letters (all in uppercase)\nType 2: KR *Country code\nType 3: Free description (up to 50 characters) *Half-width alphanumeric characters, special symbols, kanji, hiragana, katakana\nValidity check included\nOfficial example: TOKYO \n",
            "maxLength": 50
          },
          "Weight": {
            "type": "number",
            "description": "Weight\nOfficial example: 1.2 "
          },
          "Material": {
            "type": "string",
            "description": "Material of Product *Max 500\nOfficial example: 綿50%, ポリエステル50%",
            "maxLength": 500
          },
          "AdultYN": {
            "type": "string",
            "description": "If the item is an adult goods, the value is \"Y\". If not, the value is \"N\"\nOfficial example: N",
            "maxLength": 1,
            "enum": [
              "Y",
              "N"
            ]
          },
          "ContactInfo": {
            "type": "string",
            "description": "Contact Information for service manager\nOfficial example: 電話番号: 090-0000-0000 / メールアドレス: xxx@xxx.xxx",
            "maxLength": 100
          },
          "StandardImage": {
            "type": "string",
            "description": "The Standard image of item.\nPlease input the URL of the item image.\n(ex. standard image=http://image.qoo10.jo.img.jpg)\nOfficial example: https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png",
            "maxLength": 200
          },
          "VideoURL": {
            "type": "string",
            "description": "VideoURL for Item Image\nOfficial example: https://www.youtube.com/watch?v=Zhl4N5vd7NE",
            "maxLength": 200
          },
          "ItemDescription": {
            "type": "string",
            "description": "Item Description\nThis is the description in the item page. Please fill in the description with HTML format.\nOfficial example: <img src=\"https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png\">",
            "maxLength": 262144
          },
          "AdditionalOption": {
            "type": "string",
            "description": "Additional Option\nPlease use (||*) to distinguish the option information, and use ($$) to add an option.\nex.   [Option Name 1]||*[Option Detail]||*[Price]$$[Option Name 2]||*[Option Detail 2]||*[Price]\n\nOfficial example: リフィル||*選択しない||*0||*code01$$\nリフィル||*選択||*0||*code02$$\nおまけ||*タイプA||*0||*code03$$\nおまけ||*タイプB||*0||*code04",
            "maxLength": 262144
          },
          "ItemType": {
            "type": "string",
            "description": "Item type: This refers to option information that can be managed in stock.<br/>\nInput method: [Option Name]||*[Option 1]||*[Price]||*[Quantity]||*[Seller Option code]$$[Option Name]||*[Option 2]||*[Price]||*[Quantity]||*[Seller Option Code] (If no sales code is present, enter 0)<br/>\n\nex) Level 1 (if option only has color) : Color||*Blue||*100||*100||*0$$Color||*Red||*100||*50||*0 <br/>\nLevel 2 (if options are in color and size) : Color||*Blue||*Size||*L||*100||*100||*0$$Color||*Blue||*Size||*M||*100||*100||*0$$Color||*Red||*Size||*S||*100||*50||*0$$Color||*Red||*Size||*L||*100||*50||*0\nOfficial example: オプション1段階 例) カラー||*レッド||*0||*200||*Red$$\nカラー||*ブルー||*0||*200||*Blue\n\nオプション2段階 例) カラー||*レッド||*サイズ||*Sl||*0||*200||*Red_S",
            "maxLength": 262144
          },
          "RetailPrice": {
            "type": "number",
            "description": "This is the retail price.\nIn case that you don’t know the retail price, please in put \"0\"\nOfficial example: 15000",
            "minimum": 1,
            "maximum": 999999999
          },
          "ItemPrice": {
            "type": "number",
            "description": "Item Price\nOfficial example: 10000",
            "minimum": 1,
            "maximum": 999999999
          },
          "TaxRate": {
            "type": "string",
            "description": "Consumption Tax Rate </br>\nPlease select and enter the consumption tax rate from S, 10, 8, and 0 </br> </br>\nS : Default Tax Rate </br>\n10 : 10% </br>\n8 : 8% </br>\n0 : 0%\nOfficial example: 10",
            "maxLength": 2,
            "enum": [
              "S",
              "10",
              "8",
              "0"
            ]
          },
          "ItemQty": {
            "type": "integer",
            "description": "Item QTY\nOfficial example: 200",
            "minimum": 0,
            "maximum": 2147483647
          },
          "ExpireDate": {
            "type": "string",
            "description": "Expiry date to sell the item\nPlease input with this format (yyyy-mm-dd).\nIf you input \"Null\", it will be set the expirer date after 1 year.\nOfficial example: 2030-12-31",
            "maxLength": 10
          },
          "ShippingNo": {
            "type": "integer",
            "description": "Qoo10 Shipping fee code.\nPlease check out the shipping fee code at the Shipping Fee management menu in QSM. \nShipping Fee Number (Qoo10) : if input is 0, it will be set as Free Shipping.\n\nOfficial example: 123456",
            "minimum": -2147483648,
            "maximum": 2147483647
          },
          "AvailableDateType": {
            "type": "string",
            "description": "This is the type of date to which the product can be sent. Please enter a number. (0,1,2,3)\n- 0: Standard Shipping (goods that can be sent within 3 business days)\n- 1: Preparation Days\n- 2: Release Date\n- 3: Today Shipping\nOfficial example: 0",
            "maxLength": 1,
            "minLength": 1
          },
          "AvailableDateValue": {
            "type": "string",
            "description": "This is the details of the possible date type for the product can be sent. <br/>- If you enter the time, it will be sent on the same day. (Enter the shipping time of the day ex: 14:30)<br/>- If you enter 1 to 3, you will be a standard shipping product. (Enter the shipping date ex:1)<br/>- If you enter 4-14 you will be the product to set the product preparation date. (Enter Product Preparation Date ex: 5)<br/>- If you type in the format of a date, it will be ready for market. (Enter date of departure ex: 2013-09-26)\nOfficial example: 2",
            "maxLength": 10,
            "minLength": 1
          },
          "Keyword": {
            "type": "string",
            "description": "Search Keyword\nMax 10 words ex) Shirt, Denim Shirt\nOfficial example: シャツ,デニム,春",
            "maxLength": 262144
          },
          "StartDate": {
            "type": "string",
            "description": "Please enter the product sales start date in yyyy-mm-dd format.\nIf a start time is required, enter it in 30-minute increments.\n(yyyy-mm-dd hh:mm)\nOfficial example: 2020-02-02 02:00",
            "maxLength": 16
          }
        },
        "required": [
          "SecondSubCat",
          "ItemTitle",
          "ItemPrice",
          "ItemQty",
          "AvailableDateType",
          "AvailableDateValue"
        ],
        "additionalProperties": false,
        "description": "Create a product\nOfficial QAPI method 10009; version 1.1.\nQoo10에 새로운 상품을 등록하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [
        "AdditionalOption",
        "ItemType"
      ],
      "date_fields": [],
      "output_kind": "object",
      "output_types": {
        "ResultObject$$GdNo": "String",
        "ResultObject$$BIContentsNo": "Int64",
        "ResultObject$$AIContentsNo": "Int64",
        "ResultObject$$delivery_group_no": "Int32",
        "ResultObject$$GroupbuyNo": "Int32",
        "ResultObject$$QaBrandResult": "String",
        "ResultObject$$optionImgResult$$contentsNo": "Int64",
        "ResultObject$$optionImgResult$$imageUrl": "String",
        "ResultObject$$optionImgResult$$isRegistered": "Boolean",
        "ResultObject$$InventoryImgResult$$contentsNo": "Int64",
        "ResultObject$$InventoryImgResult$$imageUrl": "String",
        "ResultObject$$InventoryImgResult$$isRegistered": "Boolean"
      },
      "xml": false
    },
    "ItemsBasic.SetNewMoveGoods": {
      "id": 15757,
      "version": "1.0",
      "risk": "H",
      "description": "Set New Move Goods",
      "input_schema": {
        "type": "object",
        "properties": {
          "SellerCode": {
            "type": "string",
            "description": "[ガイド] 販売者商品コードは同一アカウント内で重複させることはできません。\n\n最大100文字\n\n販売者の管理用商品コード\nOfficial example: seller_123",
            "maxLength": 100
          },
          "SecondSubCat": {
            "type": "string",
            "description": "カテゴリコード9桁(半角数字)\nOfficial example: 320001873",
            "maxLength": 9,
            "minLength": 1
          },
          "BrandNo": {
            "type": "string",
            "description": "ブランドコード(半角数字)\nOfficial example: 27450",
            "maxLength": 10
          },
          "ItemSeriesName": {
            "type": "string",
            "description": "商品ライン/シリーズ名\n最大16文字\nOfficial example: abc1",
            "maxLength": 16
          },
          "PromotionName": {
            "type": "string",
            "description": "広告文\nOfficial example: 特価セール",
            "maxLength": 20
          },
          "ItemPrice": {
            "type": "integer",
            "description": "ItemPrice\nOfficial example: 10000",
            "minimum": 1,
            "maximum": 999999999
          },
          "RetailPrice": {
            "type": "integer",
            "description": "参考価格\nOfficial example: 15000",
            "minimum": 1,
            "maximum": 999999999
          },
          "TaxRate": {
            "type": "integer",
            "description": "Consumption Tax Rate </br>\nPlease select and enter the consumption tax rate from S, 10, 8, and 0 </br> </br>\nS : Default Tax Rate </br>\n10 : 10% </br>\n8 : 8% </br>\n0 : 0%\nOfficial example: 10",
            "minimum": -2147483648,
            "maximum": 2147483647
          },
          "OptionType": {
            "type": "string",
            "description": "オプション(タイプ)\n必須入力: オプション名、カラーコード\nオプション名: 最大20個\nメインオプション: Y表示(1個)\n\nオプション名1||*カラーコード||*Y||*モデルコード||*着用サイズ$$\nオプション名2||*カラーコード||*N||*モデルコード||*着用サイズ\n\n例1)モデル情報なし\nブラック||*#000000||*Y$$\nホワイト||*#FFFFFF||*N\n例2)モデル情報あり \nブラック||*#000000||*Y||*100||*S\nOfficial example: Black||*#000000||*Y||*100||*S",
            "maxLength": 262144,
            "minLength": 1
          },
          "OptionMainimage": {
            "type": "string",
            "description": "オプション別メイン画像\n[注意][オプション名]に入力したオプション名ごとにそれぞれ設定してください。\n\nオプション1個\n\nオプション名1||*画像URL$$\nオプション名2||*画像URL\n\n例)\nブラック||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png\nOfficial example: Black||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png",
            "maxLength": 262144,
            "minLength": 1
          },
          "OptionSubimage": {
            "type": "string",
            "description": "オプション別サブ画像\nオプション名1||*画像URL$$\nオプション名2||*画像URL1||*画像URL2||*画像URL3\n\nオプション名ごとに最大10個\nOfficial example: Black||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png$$\nRed||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png$$",
            "maxLength": 262144
          },
          "OptionQty": {
            "type": "string",
            "description": "オプション別在庫数量\nサイズがある場合\nオプション名||*サイズ名||*在庫数量||*販売者オプションコード$$\n\nサイズがない場合\nオプション名||*在庫数量||*販売者オプションコード$$\n\n\n例1)サイズあり\nブラック||*S||*200||*BLACK-S\n例2)サイズなし\nブラック||*200||*BLACK$$\nレッド||*200||*RED$$\nブルー||*200||*BLUE\nOfficial example: ブラック||*S||*200||*BLACK-S",
            "maxLength": 262144,
            "minLength": 1
          },
          "StyleNumber": {
            "type": "string",
            "description": "スタイル\n[ガイド]レディース服、メンズファッションカテゴリに限り必須入力です。\n\nスタイルコード入力\n\n最小1個、最大2個\n($$で区分)\n<br><br>\nスタイルコードの確認<br>\nhttps://qsmupload.qoo10.jp/GMKT.INC.Gsm.Web/Product/MoveDataExcelManagement.aspx\nOfficial example: STY0001$$STY0002",
            "maxLength": 262144,
            "minLength": 1
          },
          "TpoNumber": {
            "type": "string",
            "description": "TPO\nスタイル\n[ガイド]レディース服、メンズファッションカテゴリに限り必須入力です。\n\nTPOコード入力\n\n最小1個、最大2個\n($$で区分)\n\n例1)\nTPO0001\n例2)\nTPO0001$$\nTPO0002\n<br><br>\nTPOコードの確認<br>\nhttps://qsmupload.qoo10.jp/GMKT.INC.Gsm.Web/Product/MoveDataExcelManagement.aspx\nOfficial example: TPO0001$$TPO0002",
            "maxLength": 262144,
            "minLength": 1
          },
          "SeasonType": {
            "type": "string",
            "description": "シーズン\n1 : 春\n2 : 夏\n3 : 秋\n4 : 冬\n\n最大4個\n($$で区分)\n\n例1)\n1\n例2)\n1$$\n2$$\n3\nOfficial example: 1$$3",
            "maxLength": 262144,
            "minLength": 1
          },
          "MaterialInfo": {
            "type": "string",
            "description": "素材\n最大500文字\n\n例)\n表地: 綿50%、ポリエステル50%/裏地: 起毛100%\nOfficial example: 表地: 綿50%、ポリエステル50%/裏地: 起毛100%",
            "maxLength": 500
          },
          "MaterialNumber": {
            "type": "string",
            "description": "素材(検索用)素材コード入力\n最大3個($$で区分)\nOfficial example: MAT0010$$MAT0020$$MAT0030",
            "maxLength": 262144
          },
          "AttributeInfo": {
            "type": "string",
            "description": "属性\n[ガイド]小カテゴリごとに適用可能な属性グループを確認後に入力してください。\n\n属性グループコード||*属性コード1||*属性コード2||*属性コード3$$\n\n属性コード: 属性グループにより設定可能数は異なる(最大1~3個)\n\n属性グループ追加: $$で区分\nOfficial example: GATR0001||*ATR0001$$GATR0008||*ATR0073\n",
            "maxLength": 262144
          },
          "ItemDescription": {
            "type": "string",
            "description": "商品説明\nHTML code\nOfficial example: <img src=\"https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png\">",
            "x-maxBytes": 1000,
            "maxLength": 262144
          },
          "WashinginfoWashing": {
            "type": "string",
            "description": "洗濯\n[ガイド]レディース服、下着、靴下のカテゴリに限り適用されます。\n\n1 : ドライ\n2 : 洗濯機\n3 : 手洗い\nOfficial example: 1",
            "maxLength": 1
          },
          "WashinginfoStretch": {
            "type": "string",
            "description": "伸縮性\n[ガイド]レディース服、下着、靴下のカテゴリに限り適用されます。\n\n1 : あり\n2 : 若干あり\n3 : なし\nOfficial example: 1",
            "maxLength": 1
          },
          "WashinginfoFit": {
            "type": "string",
            "description": "サイズ\n[ガイド]レディース服、下着、靴下のカテゴリに限り適用されます。\n\n1 : 小さめ\n2 : 普通\n3 : 大きめ\nOfficial example: 1",
            "maxLength": 1
          },
          "WashinginfoThickness": {
            "type": "string",
            "description": "厚さ\n[ガイド]レディース服、下着、靴下のカテゴリに限り適用されます。\n\n1 : 厚い\n2 : 普通\n3 : 薄い\nOfficial example: 1",
            "maxLength": 1
          },
          "WashinginfoLining": {
            "type": "string",
            "description": "裏地\n[ガイド]レディース服カテゴリに限り適用されます。\n\n1 : あり\n2 : なし\nOfficial example: 1",
            "maxLength": 1
          },
          "WashinginfoSeethrough": {
            "type": "string",
            "description": "透け感\n[ガイド]レディース服カテゴリに限り適用されます。\n\n1 : あり\n2 : 若干あり\n3 : なし\nOfficial example: 1",
            "maxLength": 1
          },
          "ImageOtherUrl": {
            "type": "string",
            "description": "追加画像\n画像URL\n(JPG, PNG, GIF) \n\n最大50個\n(追加は$$で区分)\n\n最大10,000文字\nOfficial example: https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png$$https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png",
            "maxLength": 262144
          },
          "VideoNumber": {
            "type": "string",
            "description": "動画コード\n\n最大10個\n($$で区分)\nOfficial example: 100$$101",
            "maxLength": 262144
          },
          "SizetableType1": {
            "type": "string",
            "description": "サイズ表_タイプ1\nタイプコード入力\nOfficial example: GSIZ0001",
            "maxLength": 10
          },
          "SizetableType1Value": {
            "type": "string",
            "description": "サイズ表_値1\n[ガイド]サイズ名は[サイズ名]に入力した内容と同じものを入力してください。\n\nサイズ名||*項目コード||*内容$$\nOfficial example: S||*SIZ0001||*107$$S||*SIZ0002||*46$$S||*SIZ0003||*55",
            "maxLength": 262144
          },
          "SizetableType2": {
            "type": "string",
            "description": "サイズ表_タイプ2\nタイプコード入力\nOfficial example: GSIZ0001",
            "maxLength": 10
          },
          "SizetableType2Value": {
            "type": "string",
            "description": "サイズ表_値2\n[ガイド]サイズ名は[サイズ名]に入力した内容と同じものを入力してください。\n\nサイズ名||*項目コード||*内容$$\nOfficial example: S||*SIZ0001||*100$$\nS||*SIZ0011||*55$$\nM||*SIZ0001||*100$$\nM||*SIZ0011||*55$$\nL||*SIZ0001||*100$$\nL||*SIZ0011||*55$$",
            "maxLength": 262144
          },
          "SizetableType3": {
            "type": "string",
            "description": "サイズ表_タイプ3\nタイプコード入力\nOfficial example: GSIZ0001",
            "maxLength": 10
          },
          "SizetableType3Value": {
            "type": "string",
            "description": "サイズ表_値3\n[ガイド]サイズ名は[サイズ名]に入力した内容と同じものを入力してください。\n\nサイズ名||*項目コード||*内容$$\nOfficial example: S||*SIZ0001||*100$$\nS||*SIZ0011||*55$$\nM||*SIZ0001||*100$$\nM||*SIZ0011||*55$$\nL||*SIZ0001||*100$$\nL||*SIZ0011||*55$$",
            "maxLength": 262144
          },
          "ShippingNo": {
            "type": "integer",
            "description": "送料コード(半角数字)\n最大６桁\nOfficial example: 123456",
            "minimum": -2147483648,
            "maximum": 2147483647
          },
          "AvailableDateValue": {
            "type": "string",
            "description": "発送可能日\n[注意] 予約発送時、配送ポイントプラス点数は付与されません。\n\n一般発送:1~3(所要日数)\n当日発送:hh:mm(時刻)\n予約発送 : 4~14(所要日数字)\nOfficial example: 3",
            "maxLength": 10,
            "minLength": 1
          },
          "DesiredShippingDate": {
            "type": "string",
            "description": "お届け希望日\n3~20以内(注文日基準の選択可能日)数字\nOfficial example: 3",
            "maxLength": 10
          },
          "Keyword": {
            "type": "string",
            "description": "検索ワード\n最大10個\n\n各最大30文字\n(追加は$$で区分)\nOfficial example: バカンス$$カジュアル",
            "maxLength": 262144
          },
          "OriginType": {
            "type": "string",
            "description": "原産地\n1 : 国内\n2 : 海外\n3 : その他\nOfficial example: 1",
            "maxLength": 1,
            "minLength": 1
          },
          "OriginRegionId": {
            "type": "string",
            "description": "原産地_地域名\n[ガイド] [原産地]が国内の場合に適用されます。\n\n地域コード(英文)\nOfficial example: TOKYO",
            "maxLength": 20
          },
          "OriginCountryId": {
            "type": "string",
            "description": "原産地_国名\n[ガイド] [原産地]が「2: 海外」の場合、国コードが必須入力です。\n\n国コード 2桁(英文)\nOfficial example: CN",
            "maxLength": 2
          },
          "OriginOthers": {
            "type": "string",
            "description": "[ガイド] [原産地]が「3: その他」の場合に必須入力です。\n\n最大50文字\nOfficial example: OOに限りOO国から発送",
            "maxLength": 50
          },
          "Weight": {
            "type": "number",
            "description": "重量\n[ガイド] [送料]海外発送の場合は必須入力です。\n\n最大2桁(半角数字、小数点第1位まで可能)\n\n最大 30kg\nOfficial example: 1.5"
          },
          "ModelNM": {
            "type": "string",
            "description": "品番\n最大30文字\nOfficial example: CUH-7218BB01",
            "maxLength": 30
          },
          "IndustrialCodeType": {
            "type": "string",
            "description": "商品識別コード\nJAN : JANコード\nKAN : KANコード\nISBN : ISBNコード\nUPC : UPCコード\nEAN : EANコード\nHS : HSコード\nOfficial example: JAN",
            "maxLength": 4,
            "enum": [
              "JAN",
              "KAN",
              "ISBN",
              "UPC",
              "EAN",
              "HS"
            ]
          },
          "IndustrialCode": {
            "type": "string",
            "description": "商品識別コード_コード\n最大30文字\n\nOfficial example: TK-FBP019EBK",
            "maxLength": 13
          },
          "ManufactureDate": {
            "type": "string",
            "description": "製造日\nYYYY-MM-DD\nOfficial example: 2025-01-01",
            "maxLength": 10
          },
          "ExpirationDateType": {
            "type": "string",
            "description": "有効期間\n1: 製造日から\n2: 開封日から\n3: 指定日まで\nOfficial example: 1",
            "maxLength": 1
          },
          "ExpirationDateMFD": {
            "type": "string",
            "description": "有効期間_期間1\n1: 製造日\n最大30文字\nOfficial example: 120日まで",
            "maxLength": 30
          },
          "ExpirationDatePAO": {
            "type": "string",
            "description": "有効期間_期間2\n2: 開封日 \n最大30文字\nOfficial example: 1年以内",
            "maxLength": 30
          },
          "ExpirationDateEXP": {
            "type": "string",
            "description": "3: 有効期間\nYYYY-MM-DD\nOfficial example: 2026-01-01",
            "maxLength": 262144
          },
          "AdultYN": {
            "type": "string",
            "description": "18歳未満制限\nY: 制限する\nN: 制限しない\n\n入力していない場合、Nとして適用\nOfficial example: N",
            "maxLength": 1,
            "enum": [
              "Y",
              "N"
            ]
          },
          "ContactInfo": {
            "type": "string",
            "description": "アフターサービス担当者の情報\nOfficial example: 電話番号: 090-0000-0000 / メールアドレス: xxx@xxx.xxx",
            "maxLength": 20
          },
          "BuyLimitType": {
            "type": "string",
            "description": "購入数量制限\n1: 購入者別1回の購入数量制限\n2: 購入者別1日の購入数量制限\nOfficial example: 1",
            "maxLength": 1
          },
          "BuyLimitDate": {
            "type": "string",
            "description": "購入数量制限_期間\nYYYY-MM-DD\nOfficial example: 2026-01-01",
            "maxLength": 262144
          },
          "BuyLimitQty": {
            "type": "string",
            "description": "購入数量制限_数量\n最大2桁 (半角数字)\nOfficial example: 13",
            "maxLength": 2
          },
          "ExpireDate": {
            "type": "string",
            "description": "販売終了日\nYYYY-MM-DD\nOfficial example: 2025-12-31",
            "maxLength": 262144,
            "minLength": 1
          },
          "ShippingName": {
            "type": "string",
            "description": "Order/Delivery Management Code : \nThis information is displayed together in the product name only on the QSM order/delivery management screen, and can be used to distinguish the product.\nMax50\nOfficial example: 123456789",
            "maxLength": 50
          }
        },
        "required": [
          "SecondSubCat",
          "ItemPrice",
          "TaxRate",
          "OptionType",
          "OptionMainimage",
          "OptionQty",
          "StyleNumber",
          "TpoNumber",
          "SeasonType",
          "ShippingNo",
          "AvailableDateValue",
          "OriginType",
          "ExpireDate"
        ],
        "additionalProperties": false,
        "description": "Set New Move Goods\nOfficial QAPI method 15757; version 1.0.\nMOVE 전용 상품을 등록하기위한  API 메소드입니다."
      },
      "batch": null,
      "row_fields": [
        "OptionType",
        "OptionMainimage",
        "OptionSubimage",
        "OptionQty",
        "StyleNumber",
        "TpoNumber",
        "SeasonType",
        "MaterialNumber",
        "AttributeInfo",
        "ImageOtherUrl",
        "VideoNumber",
        "SizetableType1Value",
        "SizetableType2Value",
        "SizetableType3Value",
        "Keyword"
      ],
      "date_fields": [],
      "output_kind": "undocumented",
      "output_types": {},
      "xml": false
    },
    "ItemsBasic.UpdateGoods": {
      "id": 10010,
      "version": "1.1",
      "risk": "H",
      "description": "Update a product",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "Registered Item Code of Qoo10 \nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SecondSubCat": {
            "type": "string",
            "description": "This the category code of Qoo10 where the item will be registered.\n* You can download the information of Qoo10's Categories in the \"Bulk-data management\" menu at the QSM.\n(ex.300000001)\nOfficial example: 320001873",
            "maxLength": 20,
            "minLength": 1
          },
          "Drugtype": {
            "type": "string",
            "description": "If the Item is in Medicine Category, this field is a requirement.\n(1C : Class 1 OTC drugs, 2C : Class 2 OTC drugs, 3C : Class 3 OTC drugs, D2 : Designated Class 2 OTC drugs, QD : Quasi-drugs)\nOfficial example: 1C",
            "maxLength": 2
          },
          "ItemTitle": {
            "type": "string",
            "description": "Item Title\nOfficial example: パーフェクティングファンデーション35mlリキッドファンデーション",
            "maxLength": 100,
            "minLength": 1
          },
          "PromotionName": {
            "type": "string",
            "description": "Item Title for Promotion",
            "maxLength": 20
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "IndustrialCodeType": {
            "type": "string",
            "description": "Industrial Code Type (J: JAN, K: KAN, I: ISBN, U: UPC, E: EAN, H: HS)\nOfficial example: J",
            "maxLength": 1
          },
          "IndustrialCode": {
            "type": "string",
            "description": "This is the Industrial Code such as JAN Code or ISBN etc.\nIf you fill in the standard code, the item would be exposed in the price comparison sites.\nOfficial example: TK-FBP019EBK",
            "maxLength": 13
          },
          "BrandNo": {
            "type": "string",
            "description": "This is the brand code that is registered in Qoo10. You can request to register new brand in the QSM.\n(ex. 21750)\nOfficial example: 100550",
            "maxLength": 10
          },
          "ManufactureDate": {
            "type": "string",
            "description": "商品の製造日(YYYY-MM-DD)\nOfficial example: 2025-01-01",
            "maxLength": 10
          },
          "ModelNm": {
            "type": "string",
            "description": "Product Code\nOfficial example: CUH-7218BB01",
            "maxLength": 30
          },
          "Material": {
            "type": "string",
            "description": "The material of the item\n(ex: Polyester 50%, Synthetic 50%)\nOfficial example: 綿50%, ポリエステル50%",
            "maxLength": 500
          },
          "ProductionPlaceType": {
            "type": "string",
            "description": "Product Origin type (Domestic=1, Imported=2, etc=3)\n*Depending on the type, you can enter different values for the origin (ProductionPlace)\nIn etc, please enter \"ProductionPlaceType\" correctly. *Validity check\nOfficial example: 1",
            "maxLength": 1,
            "minLength": 1
          },
          "ProductionPlace": {
            "type": "string",
            "description": "Information of the country of origin, or place of origin.\nType1: TOKYO * Write the names of the prefectures in Roman letters (all in uppercase)\nType 2: KR *Country code\nType 3: Free description (up to 50 characters) *Half-width alphanumeric characters, special symbols, kanji, hiragana, katakana\nValidity check included\nOfficial example: TOKYO",
            "maxLength": 50
          },
          "RetailPrice": {
            "type": "string",
            "description": "This is the retail price.\nIn case that you don’t know the retail price, please in put \"0\"\nOfficial example: 15000",
            "maxLength": 262144
          },
          "AdultYN": {
            "type": "string",
            "description": "If the item is an adult goods, the value is \"Y\". If not, the value is \"N\"\nOfficial example: N",
            "maxLength": 1,
            "minLength": 1,
            "enum": [
              "Y",
              "N"
            ]
          },
          "ContactInfo": {
            "type": "string",
            "description": "Contact Information for service manager\nOfficial example: 電話番号: 090-0000-0000 / メールアドレス: xxx@xxx.xxx",
            "maxLength": 100
          },
          "ShippingNo": {
            "type": "string",
            "description": "Qoo10 Shipping fee code.\nPlease check out the shipping fee code at the Shipping Fee management menu in QSM. \nShipping Fee Number (Qoo10) : if input is 0, it will be set as Free Shipping.\nOfficial example: 123456",
            "maxLength": 262144
          },
          "OptionShippingNo1": {
            "type": "string",
            "description": "This is the aditional delivery fee that buyers will incur when they choose delivery type when making a purchase.\nPlease check out the shipping fee code to use at the Shipping Fee management menu in the QSM. \nOfficial example: 123456",
            "maxLength": 262144
          },
          "OptionShippingNo2": {
            "type": "string",
            "description": "This is the aditional delivery fee that buyers will incur when they choose delivery type when making a purchase.\nPlease check out the shipping fee code to use at the Shipping Fee management menu in the QSM. \nOfficial example: 223456",
            "maxLength": 262144
          },
          "Weight": {
            "type": "string",
            "description": "The weight of the item\n(It will be helpful to appropriate the delivery fee automatically)\nOfficial example: 1.2 ",
            "maxLength": 262144
          },
          "DesiredShippingDate": {
            "type": "string",
            "description": "The desired Shipping Date\nThis is the minimum preparatory period to dispatch the item.\nWhen the buyers order the item they can select the desired shipping date after the preparatory date has been set.\n(Not use = null, The preparatory period = a number among 3 to 20)\nOfficial example: 3",
            "maxLength": 2
          },
          "AvailableDateType": {
            "type": "string",
            "description": "This is the type of date to which the product can be sent. Please enter a number. (0,1,2,3)\n- 0: Standard Shipping (goods that can be sent within 3 business days)\n- 1: Preparation Days\n- 2: Release Date\n- 3: Today Shipping\nOfficial example: 0",
            "maxLength": 1,
            "minLength": 1
          },
          "AvailableDateValue": {
            "type": "string",
            "description": "This is the details of the possible date type for the product can be sent. <br/>- If you enter the time, it will be sent on the same day. (Enter the shipping time of the day ex: 14:30)<br/>- If you enter 1 to 3, you will be a standard shipping product. (Enter the shipping date ex:1)<br/>- If you enter 4-14 you will be the product to set the product preparation date. (Enter Product Preparation Date ex: 5)<br/>- If you type in the format of a date, it will be ready for market. (Enter date of departure ex: 2013-09-26)\nOfficial example: 2",
            "maxLength": 10,
            "minLength": 1
          },
          "Keyword": {
            "type": "string",
            "description": "Search Keyword\nMax 10 words ex) Shirt, Denim Shirt\nOfficial example: シャツ,デニム,春",
            "maxLength": 262144
          }
        },
        "required": [
          "ItemCode",
          "SecondSubCat",
          "ItemTitle",
          "ProductionPlaceType",
          "AdultYN",
          "AvailableDateType",
          "AvailableDateValue"
        ],
        "additionalProperties": false,
        "description": "Update a product\nOfficial QAPI method 10010; version 1.1.\n판매자상품의 정보를 수정하는 Method입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsBasic.SetGoodsSubDeliveryGroup": {
      "id": 10012,
      "version": "1.0",
      "risk": "H",
      "description": "Set Goods Sub Delivery Group",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "Registered Item Code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "AddSRcode1": {
            "type": "string",
            "description": "This is the aditional delivery fee that buyers will incur when they choose delivery type when making a purchase.\nPlease check out the shipping fee code to use at the Shipping Fee management menu in the QSM. \nOfficial example: 123456",
            "maxLength": 262144
          },
          "AddSRcode2": {
            "type": "string",
            "description": "This is the aditional delivery fee that buyers will incur when they choose delivery type when making a purchase.\nPlease check out the shipping fee code to use at the Shipping Fee management menu in the QSM. \nOfficial example: 223456",
            "maxLength": 262144
          }
        },
        "required": [
          "ItemCode"
        ],
        "additionalProperties": false,
        "description": "Set Goods Sub Delivery Group\nOfficial QAPI method 10012; version 1.0.\n복수 배송비 정보를 설정하는  Method입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsBasic.EditGoodsStatus": {
      "id": 10013,
      "version": "1.0",
      "risk": "D",
      "description": "Change product selling status",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "Registered Item Code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "Status": {
            "type": "string",
            "description": "The information about the status of the item.\nPlease input the number of the status to change.\n(On queue = 1, Transaction available = 2, Transaction discontinued = 3)\nOfficial example: 2",
            "maxLength": 262144,
            "minLength": 1,
            "enum": [
              "1",
              "2",
              "3"
            ]
          }
        },
        "required": [
          "ItemCode",
          "Status"
        ],
        "additionalProperties": false,
        "description": "Change product selling status\nOfficial QAPI method 10013; version 1.0.\n상품 거래상태 정보를 변경하는 Method입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsBasic.EditItemCondition": {
      "id": 10014,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Item Condition",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "Registered Item Code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "ItemCondition": {
            "type": "string",
            "description": "The condition of item\n(New item = N, Used item = U)\nOfficial example: N",
            "maxLength": 1,
            "minLength": 1,
            "enum": [
              "N",
              "U"
            ]
          },
          "UseCondition": {
            "type": "string",
            "description": "Please elaborate the used condition of the item when you register the used item.\n(Refurbished = 1, Not used = 2, Mint = 3, Good = 4, A bit old = 5, Unserviceable = 6, Null = Mint)\nOfficial example: 2",
            "maxLength": 262144
          }
        },
        "required": [
          "ItemCode",
          "ItemCondition"
        ],
        "additionalProperties": false,
        "description": "Edit Item Condition\nOfficial QAPI method 10014; version 1.0.\n상품상태(새상품, 중고여부)  정보를 변경하는 Method입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsBasic.UpdateMoveGoods": {
      "id": 15758,
      "version": "1.0",
      "risk": "H",
      "description": "Update Move Goods",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "商品番号(半角数字)\n\n例) 1234567890\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "[ガイド] 販売者商品コードは同一アカウント内で重複させることはできません。\n\n最大100文字\n\n販売者の管理用商品コード\nOfficial example: seller_123",
            "maxLength": 100
          },
          "SecondSubCat": {
            "type": "string",
            "description": "カテゴリコード9桁(半角数字)\nOfficial example: 320001873",
            "maxLength": 9,
            "minLength": 1
          },
          "BrandNo": {
            "type": "string",
            "description": "ブランドコード(半角数字)\nOfficial example: 27450",
            "maxLength": 10
          },
          "ItemSeriesName": {
            "type": "string",
            "description": "商品ライン/シリーズ名\n最大16文字\nOfficial example: abc1",
            "maxLength": 16
          },
          "PromotionName": {
            "type": "string",
            "description": "広告文\n最大20文字\nOfficial example: 特価セール",
            "maxLength": 20
          },
          "ItemPrice": {
            "type": "integer",
            "description": "ItemPrice\nOfficial example: 10000",
            "minimum": 1,
            "maximum": 999999999
          },
          "RetailPrice": {
            "type": "integer",
            "description": "참고가격\n최대9자리(숫자)\nOfficial example: 15000",
            "minimum": 1,
            "maximum": 999999999
          },
          "TaxRate": {
            "type": "string",
            "description": "Consumption Tax Rate </br>\nPlease select and enter the consumption tax rate from S, 10, 8, and 0 </br> </br>\nS : Default Tax Rate </br>\n10 : 10% </br>\n8 : 8% </br>\n0 : 0%\nOfficial example: 10",
            "maxLength": 2,
            "enum": [
              "S",
              "10",
              "8",
              "0"
            ]
          },
          "OptionType": {
            "type": "string",
            "description": "オプション(タイプ)\n必須入力: オプション名、カラーコード\nオプション名: 最大20個\nメインオプション: Y表示(1個)\n\nオプション名1||*カラーコード||*Y||*モデルコード||*着用サイズ$$\nオプション名2||*カラーコード||*N||*モデルコード||*着用サイズ\n\n例1)モデル情報なし\nブラック||*#000000||*Y$$\nホワイト||*#FFFFFF||*N\n例2)モデル情報あり \nブラック||*#000000||*Y||*100||*S\nOfficial example: Black||*#000000||*Y||*100||*S",
            "maxLength": 262144,
            "minLength": 1
          },
          "OptionMainimage": {
            "type": "string",
            "description": "オプション別メイン画像\n[注意][オプション名]に入力したオプション名ごとにそれぞれ設定してください。\n\nオプション1個\n\nオプション名1||*画像URL$$\nオプション名2||*画像URL\n\n例)\nブラック||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png\nOfficial example: Black||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png",
            "maxLength": 262144,
            "minLength": 1
          },
          "OptionSubimage": {
            "type": "string",
            "description": "オプション別サブ画像\nオプション名1||*画像URL$$\nオプション名2||*画像URL1||*画像URL2||*画像URL3\n\nオプション名ごとに最大10個\n\n例)\nブラック||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png$$\nレッド||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png$$\nOfficial example: Black||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png$$\nRed||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png$$",
            "maxLength": 262144
          },
          "OptionQty": {
            "type": "string",
            "description": "オプション別在庫数量\nサイズがある場合\nオプション名||*サイズ名||*在庫数量||*販売者オプションコード$$\n\nサイズがない場合\nオプション名||*在庫数量||*販売者オプションコード$$\n\n\n例1)サイズあり\nブラック||*S||*200||*BLACK-S\n例2)サイズなし\nブラック||*200||*BLACK$$\nレッド||*200||*RED$$\nブルー||*200||*BLUE\nOfficial example: ブラック||*S||*200||*BLACK-S",
            "maxLength": 262144,
            "minLength": 1
          },
          "StyleNumber": {
            "type": "string",
            "description": "スタイル\nスタイル\n[ガイド]レディース服、メンズファッションカテゴリに限り必須入力です。\n\nスタイルコード入力\n\n最小1個、最大2個\n($$で区分)\n<br><br>\nスタイルコードの確認<br>\nhttps://qsmupload.qoo10.jp/GMKT.INC.Gsm.Web/Product/MoveDataExcelManagement.aspx\nOfficial example: STY0001$$STY0002",
            "maxLength": 262144,
            "minLength": 1
          },
          "TpoNumber": {
            "type": "string",
            "description": "TPO\n[ガイド]レディース服カテゴリに限り必須入力です。\n\nTPOコード入力\n\n最小1個、最大2個\n($$で区分)\n<br><br>\nTPOコードの確認<br>\nhttps://qsmupload.qoo10.jp/GMKT.INC.Gsm.Web/Product/MoveDataExcelManagement.aspx\nOfficial example: TPO0001$$TPO0002",
            "maxLength": 262144,
            "minLength": 1
          },
          "SeasonType": {
            "type": "string",
            "description": "シーズン\n1 : 春\n2 : 夏\n3 : 秋\n4 : 冬\n\n最大4個\n($$で区分)\nOfficial example: 1$$3",
            "maxLength": 262144,
            "minLength": 1
          },
          "MaterialInfo": {
            "type": "string",
            "description": "素材\n最大500文字\nOfficial example: 表地: 綿50%、ポリエステル50%/裏地: 起毛100%",
            "maxLength": 500
          },
          "MaterialNumber": {
            "type": "string",
            "description": "素材(検索用)\n素材コード入力\n\n最大3個\n($$で区分)\n\n例1)\nMAT0010\n例2) \nMAT0010$$\nMAT0020$$\nMAT0030\nOfficial example: MAT0010$$MAT0020$$MAT0030",
            "maxLength": 262144
          },
          "AttributeInfo": {
            "type": "string",
            "description": "属性\n[ガイド]小カテゴリごとに適用可能な属性グループを確認後に入力してください。\n\n属性グループコード||*属性コード1||*属性コード2||*属性コード3$$\n\n属性コード: 属性グループにより設定可能数は異なる(最大1~3個)\n\n属性グループ追加: $$で区分\nOfficial example: GATR0001||*ATR0001$$GATR0008||*ATR0073",
            "maxLength": 262144
          },
          "ItemDescription": {
            "type": "string",
            "description": "商品説明\nHTML code\nOfficial example: <img src=\"https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png\">",
            "x-maxBytes": 1000,
            "maxLength": 262144
          },
          "WashinginfoWashing": {
            "type": "string",
            "description": "洗濯\n[ガイド]レディース服、下着、靴下のカテゴリに限り適用されます。\n\n1 : ドライ\n2 : 洗濯機\n3 : 手洗い\nOfficial example: 1",
            "maxLength": 1
          },
          "WashinginfoStretch": {
            "type": "string",
            "description": "伸縮性\n[ガイド]レディース服、下着、靴下のカテゴリに限り適用されます。\n\n1 : あり\n2 : 若干あり\n3 : なし\nOfficial example: 1",
            "maxLength": 1
          },
          "WashinginfoFit": {
            "type": "string",
            "description": "サイズ\n[ガイド]レディース服、下着、靴下のカテゴリに限り適用されます。\n\n1 : 小さめ\n2 : 普通\n3 : 大きめ\nOfficial example: 1",
            "maxLength": 1
          },
          "WashinginfoThickness": {
            "type": "string",
            "description": "厚さ\n[ガイド]レディース服、下着、靴下のカテゴリに限り適用されます。\n\n1 : 厚い\n2 : 普通\n3 : 薄い\nOfficial example: 1",
            "maxLength": 1
          },
          "WashinginfoLining": {
            "type": "string",
            "description": "裏地\n[ガイド]レディース服カテゴリに限り適用されます。\n\n1 : あり\n2 : なし\nOfficial example: 1",
            "maxLength": 1
          },
          "WashinginfoSeethrough": {
            "type": "string",
            "description": "透け感\n[ガイド]レディース服カテゴリに限り適用されます。\n\n1 : あり\n2 : 若干あり\n3 : なし\nOfficial example: 1",
            "maxLength": 1
          },
          "ImageOtherUrl": {
            "type": "string",
            "description": "追加画像\n画像URL\n(JPG, PNG, GIF) \n\n最大50個\n(追加は$$で区分)\n\n最大10,000文字\nOfficial example: https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png$$https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png",
            "maxLength": 262144
          },
          "VideoNumber": {
            "type": "string",
            "description": "動画コード\n\n最大10個\n($$で区分)\nOfficial example: 100$$101",
            "maxLength": 262144
          },
          "SizetableType1": {
            "type": "string",
            "description": "サイズ表_タイプ1\nタイプコード入力\nOfficial example: GSIZ0001",
            "maxLength": 10
          },
          "SizetableType1Value": {
            "type": "string",
            "description": "サイズ表_値1\n[ガイド]サイズ名は[サイズ名]に入力した内容と同じものを入力してください。\n\nサイズ名||*項目コード||*内容$$\nOfficial example: S||*SIZ0001||*107$$S||*SIZ0002||*46$$S||*SIZ0003||*55",
            "maxLength": 262144
          },
          "SizetableType2": {
            "type": "string",
            "description": "サイズ表_タイプ2\nタイプコード入力\nOfficial example: GSIZ0001",
            "maxLength": 10
          },
          "SizetableType2Value": {
            "type": "string",
            "description": "サイズ表_値2\n[ガイド]サイズ名は[サイズ名]に入力した内容と同じものを入力してください。\n\nサイズ名||*項目コード||*内容$$\nOfficial example: S||*SIZ0001||*100$$\nS||*SIZ0011||*55$$\nM||*SIZ0001||*100$$\nM||*SIZ0011||*55$$\nL||*SIZ0001||*100$$\nL||*SIZ0011||*55$$",
            "maxLength": 262144
          },
          "SizetableType3": {
            "type": "string",
            "description": "サイズ表_タイプ3\nタイプコード入力\nOfficial example: GSIZ0001",
            "maxLength": 10
          },
          "SizetableType3Value": {
            "type": "string",
            "description": "サイズ表_値3\n[ガイド]サイズ名は[サイズ名]に入力した内容と同じものを入力してください。\n\nサイズ名||*項目コード||*内容$$\nOfficial example: S||*SIZ0001||*100$$\nS||*SIZ0011||*55$$\nM||*SIZ0001||*100$$\nM||*SIZ0011||*55$$\nL||*SIZ0001||*100$$\nL||*SIZ0011||*55$$",
            "maxLength": 262144
          },
          "ShippingNo": {
            "type": "integer",
            "description": "送料コード(半角数字)\n最大６桁\nOfficial example: 123456",
            "minimum": -2147483648,
            "maximum": 2147483647
          },
          "AvailableDateValue": {
            "type": "string",
            "description": "発送可能日\n[注意] 予約発送時、配送ポイントプラス点数は付与されません。\n\n一般発送:1~3(所要日数)\n当日発送:hh:mm(時刻)\n予約発送 : 4~14(所要日数字)\nOfficial example: 3",
            "maxLength": 10,
            "minLength": 1
          },
          "DesiredShippingDate": {
            "type": "string",
            "description": "お届け希望日\n3~20以内(注文日基準の選択可能日)数字\nOfficial example: 3",
            "maxLength": 10
          },
          "Keyword": {
            "type": "string",
            "description": "検索ワード\n最大10個\n\n各最大30文字\n(追加は$$で区分)\nOfficial example: バカンス$$カジュアル",
            "maxLength": 262144
          },
          "OriginType": {
            "type": "string",
            "description": "原産地\n1 : 国内\n2 : 海外\n3 : その他\nOfficial example: 1",
            "maxLength": 1,
            "minLength": 1
          },
          "OriginRegionId": {
            "type": "string",
            "description": "原産地_地域名\n[ガイド] [原産地]が国内の場合に適用されます。\n\n地域コード(英文)\nOfficial example: TOKYO",
            "maxLength": 20
          },
          "OriginCountryId": {
            "type": "string",
            "description": "[ガイド] [原産地]が「2: 海外」の場合、国コードが必須入力です。\n\n国コード 2桁(英文)\nOfficial example: CN",
            "maxLength": 2
          },
          "OriginOthers": {
            "type": "string",
            "description": "[ガイド] [原産地]が「3: その他」の場合に必須入力です。\n\n最大50文字\nOfficial example: OOに限りOO国から発送",
            "maxLength": 50
          },
          "Weight": {
            "type": "number",
            "description": "重量\n[ガイド] [送料]海外発送の場合は必須入力です。\n\n最大2桁(半角数字、小数点第1位まで可能)\n\n最大 30kg\n\n例1) 1\n例2)  1.5\nOfficial example: 1.5"
          },
          "ModelNM": {
            "type": "string",
            "description": "品番\n最大30文字\nOfficial example: CUH-7218BB01",
            "maxLength": 30
          },
          "IndustrialCodeType": {
            "type": "string",
            "description": "商品識別コード\nJAN : JANコード\nKAN : KANコード\nISBN : ISBNコード\nUPC : UPCコード\nEAN : EANコード\nHS : HSコード\nOfficial example: JAN",
            "maxLength": 4,
            "enum": [
              "JAN",
              "KAN",
              "ISBN",
              "UPC",
              "EAN",
              "HS"
            ]
          },
          "IndustrialCode": {
            "type": "string",
            "description": "商品識別コード_コード\n最大30文字\nOfficial example: TK-FBP019EBK",
            "maxLength": 13
          },
          "ManufactureDate": {
            "type": "string",
            "description": "製造日\nYYYY-MM-DD\nOfficial example: 2025-01-01",
            "maxLength": 10
          },
          "ExpirationDateType": {
            "type": "string",
            "description": "有効期間\n1: 製造日から\n2: 開封日から\n3: 指定日まで\nOfficial example: 1",
            "maxLength": 1
          },
          "ExpirationDateMFD": {
            "type": "string",
            "description": "有効期間_期間1\n1: 製造日\n最大30文字\nOfficial example: 120日まで",
            "maxLength": 30
          },
          "ExpirationDatePAO": {
            "type": "string",
            "description": "有効期間_期間2\n2: 開封日 \n最大30文字\nOfficial example: 1年以内",
            "maxLength": 30
          },
          "ExpirationDateEXP": {
            "type": "string",
            "description": "3: 有効期間\nYYYY-MM-DD\nOfficial example: 2026-01-01",
            "maxLength": 262144
          },
          "AdultYN": {
            "type": "string",
            "description": "18歳未満制限\nY: 制限する\nN: 制限しない\n\n入力していない場合、Nとして適用\nOfficial example: N",
            "maxLength": 1,
            "enum": [
              "Y",
              "N"
            ]
          },
          "ContactInfo": {
            "type": "string",
            "description": "アフターサービス担当者の情報\nOfficial example: 電話番号: 090-0000-0000 / メールアドレス: xxx@xxx.xxx",
            "maxLength": 20
          },
          "BuyLimitType": {
            "type": "string",
            "description": "購入数量制限\n1: 購入者別1回の購入数量制限\n2: 購入者別1日の購入数量制限\nOfficial example: 1",
            "maxLength": 1
          },
          "BuyLimitDate": {
            "type": "string",
            "description": "購入数量制限_期間\nYYYY-MM-DD\nOfficial example: 2026-01-01",
            "maxLength": 262144
          },
          "BuyLimitQty": {
            "type": "string",
            "description": "購入数量制限_数量\n最大2桁 (半角数字)\nOfficial example: 13",
            "maxLength": 2
          },
          "ExpireDate": {
            "type": "string",
            "description": "販売終了日\nYYYY-MM-DD\n\nOfficial example: 2025-12-31",
            "maxLength": 262144,
            "minLength": 1
          },
          "ShippingName": {
            "type": "string",
            "description": "Order/Delivery Management Code :\nThis information is displayed together in the product name only on the QSM order/delivery management screen, and can be used to distinguish the product.\nOfficial example: 123456789",
            "maxLength": 50
          }
        },
        "required": [
          "ItemCode",
          "SecondSubCat",
          "ItemPrice",
          "OptionType",
          "OptionMainimage",
          "OptionQty",
          "StyleNumber",
          "TpoNumber",
          "SeasonType",
          "ShippingNo",
          "AvailableDateValue",
          "OriginType",
          "ExpireDate"
        ],
        "additionalProperties": false,
        "description": "Update Move Goods\nOfficial QAPI method 15758; version 1.0.\n등록된 MOVE 전용 상품을 수정하는 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [
        "OptionType",
        "OptionMainimage",
        "OptionSubimage",
        "OptionQty",
        "StyleNumber",
        "TpoNumber",
        "SeasonType",
        "MaterialNumber",
        "AttributeInfo",
        "ImageOtherUrl",
        "VideoNumber",
        "SizetableType1Value",
        "SizetableType2Value",
        "SizetableType3Value",
        "Keyword"
      ],
      "date_fields": [],
      "output_kind": "undocumented",
      "output_types": {},
      "xml": false
    },
    "ItemsBasic.EditMoveGoodsStatus": {
      "id": 15764,
      "version": "1.0",
      "risk": "D",
      "description": "Edit Move Goods Status",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "Registered Item Code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: Seller_1234567890",
            "maxLength": 100
          },
          "Status": {
            "type": "string",
            "description": "The information about the status of the item.\nPlease input the number of the status to change.\n(On queue = 1, Transaction available = 2, Transaction discontinued = 3)\nOfficial example: 2",
            "maxLength": 262144,
            "minLength": 1,
            "enum": [
              "1",
              "2",
              "3"
            ]
          }
        },
        "required": [
          "ItemCode",
          "Status"
        ],
        "additionalProperties": false,
        "description": "Edit Move Goods Status\nOfficial QAPI method 15764; version 1.0.\nMOVE 상품 거래상태 정보를 변경하는 Method입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "undocumented",
      "output_types": {},
      "xml": false
    },
    "ItemsOrder.SetGoodsPriceQty": {
      "id": 10024,
      "version": "1.1",
      "risk": "H",
      "description": "Set Goods Price Qty",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "Registered Item Code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "Price": {
            "type": "string",
            "description": "Item Price (optional) \nOfficial example: 10000",
            "maxLength": 262144
          },
          "TaxRate": {
            "type": "string",
            "description": "Consumption Tax Rate </br>\nPlease select and enter the consumption tax rate from S, 10, 8, and 0 </br> </br>\nS : Default Tax Rate </br>\n10 : 10% </br>\n8 : 8% </br>\n0 : 0%\nOfficial example: 10",
            "maxLength": 2,
            "enum": [
              "S",
              "10",
              "8",
              "0"
            ]
          },
          "Qty": {
            "type": "string",
            "description": "Item Quantity <br />\nIf you enter unchanged, the existing stock quantity is retained.\nOfficial example: 200\nProvider default: 9999",
            "maxLength": 262144
          },
          "ExpireDate": {
            "type": "string",
            "description": "Expiry date to sell the item\nPlease input with this format (yyyy-mm-dd).\nIf you input \"Null\", it will be set the expirer date after 1 year.\nOfficial example: 2030-12-31",
            "maxLength": 10
          },
          "StartDate": {
            "type": "string",
            "description": "Please enter the product sales start date in yyyy-mm-dd format.\nIf a start time is required, enter it in 30-minute increments.\n(yyyy-mm-dd hh:mm)\nOfficial example: 2020-02-02 2:00",
            "maxLength": 16
          }
        },
        "required": [
          "ItemCode"
        ],
        "additionalProperties": false,
        "description": "Set Goods Price Qty\nOfficial QAPI method 10024; version 1.1.\nQoo10에 등록한 상품의 가격, 수량, 판매기한을 수정하는 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsOrder.UpdateItemDiscount": {
      "id": 10025,
      "version": "1.0",
      "risk": "H",
      "description": "Update Item Discount",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "BeginDate": {
            "type": "string",
            "description": "Start date of the discount (YYYY-MM-DD)\nOfficial example: 2025-06-01",
            "maxLength": 10
          },
          "EndDate": {
            "type": "string",
            "description": "End date of the discount (YYYY-MM-DD)\nOfficial example: 2025-05-31",
            "maxLength": 10
          },
          "CostPrice": {
            "type": "string",
            "description": "Amount of the discount(type1: 1~49%, type2: 0~999999999)\nOfficial example: 10",
            "maxLength": 262144
          },
          "DiscountType": {
            "type": "string",
            "description": "Type of the discount (No discount = 0, fixed rate discount = 1, fixed amount discount = 2)\nOfficial example: 1",
            "maxLength": 1,
            "minLength": 1,
            "enum": [
              "0",
              "1",
              "2"
            ]
          }
        },
        "required": [
          "ItemCode",
          "DiscountType"
        ],
        "additionalProperties": false,
        "description": "Update Item Discount\nOfficial QAPI method 10025; version 1.0.\n등록한 상품에 할인을 설정/수정하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsOrder.EditGoodsOrderLimit": {
      "id": 10026,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Goods Order Limit",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "Qoo10 item code \nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "Seller Item code \nOfficial example: abc_1234",
            "maxLength": 100
          },
          "LimitType": {
            "type": "string",
            "description": "Limit Type (0: limited quantity per purchase, 1: limited quantity per person) \nOfficial example: 1",
            "maxLength": 10
          },
          "LimitCnt": {
            "type": "string",
            "description": "number of items \nOfficial example: 10",
            "maxLength": 262144
          },
          "EndDate": {
            "type": "string",
            "description": "End selling date\nYYYY-MM-DD\n\nOfficial example: 2025-12-31",
            "maxLength": 10
          }
        },
        "required": [
          "ItemCode"
        ],
        "additionalProperties": false,
        "description": "Edit Goods Order Limit\nOfficial QAPI method 10026; version 1.0.\n상품에 구매 가능 수량을 설정하는 Method 입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsOrder.SetGoodsPriceQtyBulk": {
      "id": 15238,
      "version": "1.1",
      "risk": "H",
      "description": "Set Goods Price Qty Bulk",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemInfoJson": {
            "type": "array",
            "minItems": 1,
            "maxItems": 10,
            "description": "Price, Quantity and Expiry date and TaxRate in JSON format (Max 500) <br/>\nSample: [{\"ItemCode\":\"String\",\"SellerCode\":\"String\",\"Price\":String,\"TaxRate\":\"String\",\"Qty\":String,\"ExpireDate\":\"String\",\"StartDate\":\"String\"},{\"ItemCode\":\"String\",\"SellerCode\":\"String\",\"Price\":String,\"TaxRate\":\"String\",\"Qty\":String,\"ExpireDate\":\"String\",\"StartDate\":\"String\"}]\nOfficial example: [{\"ItemCode\":\"String\",\"SellerCode\":\"String\",\"Price\":String,\"TaxRate\":\"String\",\"Qty\":String,\"ExpireDate\":\"String\",\"StartDate\":\"String\"},{\"ItemCode\":\"String\",\"SellerCode\":\"String\",\"Price\":String,\"TaxRate\":\"String\",\"Qty\":String,\"ExpireDate\":\"String\",\"StartDate\":\"String\"}]\nPass a typed array; the connector serializes it to the documented JSON string.",
            "items": {
              "type": "object",
              "properties": {
                "ItemCode": {
                  "type": "string",
                  "description": "Registered Item Code of Qoo10\nOfficial example: 1234567890",
                  "maxLength": 10,
                  "minLength": 1,
                  "pattern": "^[1-9][0-9]{0,9}$"
                },
                "SellerCode": {
                  "type": "string",
                  "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
                  "maxLength": 100
                },
                "Price": {
                  "type": "string",
                  "description": "Item Price (optional) \nOfficial example: 10000",
                  "maxLength": 262144
                },
                "TaxRate": {
                  "type": "string",
                  "description": "Consumption Tax Rate </br>\nPlease select and enter the consumption tax rate from S, 10, 8, and 0 </br> </br>\nS : Default Tax Rate </br>\n10 : 10% </br>\n8 : 8% </br>\n0 : 0%\nOfficial example: 10",
                  "maxLength": 2,
                  "enum": [
                    "S",
                    "10",
                    "8",
                    "0"
                  ]
                },
                "Qty": {
                  "type": "string",
                  "description": "Item Quantity <br />\nIf you enter unchanged, the existing stock quantity is retained.\nOfficial example: 200\nProvider default: 9999",
                  "maxLength": 262144
                },
                "ExpireDate": {
                  "type": "string",
                  "description": "Expiry date to sell the item\nPlease input with this format (yyyy-mm-dd).\nIf you input \"Null\", it will be set the expirer date after 1 year.\nOfficial example: 2030-12-31",
                  "maxLength": 10
                },
                "StartDate": {
                  "type": "string",
                  "description": "Please enter the product sales start date in yyyy-mm-dd format.\nIf a start time is required, enter it in 30-minute increments.\n(yyyy-mm-dd hh:mm)\nOfficial example: 2020-02-02 2:00",
                  "maxLength": 16
                }
              },
              "required": [
                "ItemCode"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "ItemInfoJson"
        ],
        "additionalProperties": false,
        "description": "Set Goods Price Qty Bulk\nOfficial QAPI method 15238; version 1.1.\n복수의 상품의 가격/재고를 수정하는 기능입니다."
      },
      "batch": {
        "field": "ItemInfoJson",
        "kind": "unverified_dictionary"
      },
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$Count": "Int32",
        "ResultObject$$Keys$$Count": "Int32",
        "ResultObject$$Values$$Count": "Int32"
      },
      "xml": false
    },
    "ItemsOrder.EditMoveGoodsPrice": {
      "id": 15759,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Move Goods Price",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "商品番号(半角数字)\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "販売者商品コード\n[ガイド] 販売者商品コードは同一アカウント内で重複させることはできません。\n最大100文字\n販売者の管理用商品コード\nOfficial example: Seller_123",
            "maxLength": 100
          },
          "ItemPrice": {
            "type": "string",
            "description": "販売価格\n最大9桁(半角数字)\nOfficial example: 10000",
            "maxLength": 262144,
            "minLength": 1
          }
        },
        "required": [
          "ItemCode",
          "ItemPrice"
        ],
        "additionalProperties": false,
        "description": "Edit Move Goods Price\nOfficial QAPI method 15759; version 1.0.\n등록된 MOVE 상품의 가격을 수정하는 API Method 입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "undocumented",
      "output_types": {},
      "xml": false
    },
    "ItemsOrder.UpdateMoveItemDiscount": {
      "id": 15765,
      "version": "1.0",
      "risk": "H",
      "description": "Update Move Item Discount",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "MOVE item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "BeginDate": {
            "type": "string",
            "description": "Start date of the discount (YYYY-MM-DD)\nOfficial example: 2025-06-01",
            "maxLength": 10
          },
          "EndDate": {
            "type": "string",
            "description": "End date of the discount (YYYY-MM-DD)\nOfficial example: 2025-05-31",
            "maxLength": 10
          },
          "CostPrice": {
            "type": "string",
            "description": "Amount of the discount(type1: 1~49%, type2: 0~999999999)\nOfficial example: 10",
            "maxLength": 262144
          },
          "DiscountType": {
            "type": "string",
            "description": "Type of the discount (No discount = 0, fixed rate discount = 1, fixed amount discount = 2)\nOfficial example: 1",
            "maxLength": 1,
            "minLength": 1,
            "enum": [
              "0",
              "1",
              "2"
            ]
          }
        },
        "required": [
          "ItemCode",
          "DiscountType"
        ],
        "additionalProperties": false,
        "description": "Update Move Item Discount\nOfficial QAPI method 15765; version 1.0.\n등록된 MOVE 상품에 할인 설정/수정하는 API 입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "undocumented",
      "output_types": {},
      "xml": false
    },
    "ItemsOptions.EditGoodsInventory": {
      "id": 10018,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Goods Inventory",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "InventoryInfo": {
            "type": "string",
            "description": "Combined Option Information\nYou can set the combined option that has the price and inventory information by each option using these parameters.\nInput format : Column separator(||*), Row separator($$) -->[Option name 1]||*[Option detail 1]||*[Price]||*[QTY]||*[Option Code]$$[Option name 2]||*[Opt\nOfficial example: color||*red||*0||*10||*red-1$$color||*blue||*500||*15||*blue-1",
            "maxLength": 262144
          }
        },
        "required": [
          "ItemCode"
        ],
        "additionalProperties": false,
        "description": "Edit Goods Inventory\nOfficial QAPI method 10018; version 1.0.\nQoo10에 등록한 상품의 조합형 옵션정보를 설정 및 수정하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [
        "InventoryInfo"
      ],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsOptions.EditGoodsTextOption": {
      "id": 10017,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Goods Text Option",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "TextOptions": {
            "type": "string",
            "description": "Setting the text option\nWhen the buyers select the options, they can input the options as a text.\nInput format : column separator (||*), Row separator ($$) -->[Option name 1]||*1$$[Option name 2]||*2$$[option name 3]||*3\nOfficial example: [オプション名1]||*1$$[オプション名2]||*2$$[オプション名3]||*3",
            "maxLength": 262144
          }
        },
        "required": [
          "ItemCode"
        ],
        "additionalProperties": false,
        "description": "Edit Goods Text Option\nOfficial QAPI method 10017; version 1.0.\n텍스트 옵션 정보를 수정하는 Method입니다."
      },
      "batch": null,
      "row_fields": [
        "TextOptions"
      ],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsOptions.EditGoodsOption": {
      "id": 10016,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Goods Option",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "AdditionalOption": {
            "type": "string",
            "description": "Additional option information of the product : it is possible to sell various type of the products using the options.\nInput format : column separator (||*), row separator ($$)\n--> [Option name 1]||*[Option detail 1]||*[Price]$$[Option name 2]||*[Option detail 2]||*[Price]\nExample: In case the mo\nOfficial example: リフィル||*選択しない||*0||*code01$$リフィル||*選択||*0||*code02$$おまけ||*タイプA||*0||*code03$$おまけ||*タイプB||*0||*code04",
            "maxLength": 262144
          }
        },
        "required": [
          "ItemCode"
        ],
        "additionalProperties": false,
        "description": "Edit Goods Option\nOfficial QAPI method 10016; version 1.0.\nQoo10에 등록한 판매자 상품의 단일형 옵션정보를 수정하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [
        "AdditionalOption"
      ],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsOptions.DeleteInventoryDataUnit": {
      "id": 10019,
      "version": "1.0",
      "risk": "D",
      "description": "Delete an inventory option",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "OptionName": {
            "type": "string",
            "description": "Option Name \nOfficial example: カラー、サイズ",
            "maxLength": 50,
            "minLength": 1
          },
          "OptionValue": {
            "type": "string",
            "description": "Option Value \nOfficial example: RED,S,M,L",
            "maxLength": 50,
            "minLength": 1
          },
          "OptionCode": {
            "type": "string",
            "description": "Option code \nOfficial example: Red_S",
            "maxLength": 50,
            "minLength": 1
          }
        },
        "required": [
          "ItemCode",
          "OptionName",
          "OptionValue",
          "OptionCode"
        ],
        "additionalProperties": false,
        "description": "Delete an inventory option\nOfficial QAPI method 10019; version 1.0.\nQoo10에 등록한 상품의 조합협 옵션정보를 삭제하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsOptions.InsertInventoryDataUnit": {
      "id": 10020,
      "version": "1.0",
      "risk": "H",
      "description": "Insert Inventory Data Unit",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "OptionName": {
            "type": "string",
            "description": "Option Name \nOfficial example: カラー、サイズ",
            "maxLength": 50,
            "minLength": 1
          },
          "OptionValue": {
            "type": "string",
            "description": "Option Value \nOfficial example: RED,S,M,L",
            "maxLength": 50,
            "minLength": 1
          },
          "OptionCode": {
            "type": "string",
            "description": "Option code \nOfficial example: Red_S",
            "maxLength": 50
          },
          "Price": {
            "type": "number",
            "description": "Option Price\nOfficial example: 5000",
            "minimum": 1,
            "maximum": 999999999
          },
          "Qty": {
            "type": "integer",
            "description": "Option Quantity \nOfficial example: 100",
            "minimum": 0,
            "maximum": 2147483647
          }
        },
        "required": [
          "ItemCode",
          "OptionName",
          "OptionValue"
        ],
        "additionalProperties": false,
        "description": "Insert Inventory Data Unit\nOfficial QAPI method 10020; version 1.0.\nQoo10에 등록한 상품의 조합형 옵션정보를 추가 등록하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsOptions.UpdateInventoryDataUnit": {
      "id": 10021,
      "version": "1.0",
      "risk": "H",
      "description": "Update Inventory Data Unit",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "OptionName": {
            "type": "string",
            "description": "Option Name \nOfficial example: カラー、サイズ",
            "maxLength": 50,
            "minLength": 1
          },
          "OptionValue": {
            "type": "string",
            "description": "Option Value \nOfficial example: RED,S,M,L",
            "maxLength": 50,
            "minLength": 1
          },
          "OptionCode": {
            "type": "string",
            "description": "Option code \nOfficial example: Red_S",
            "maxLength": 50,
            "minLength": 1
          },
          "Price": {
            "type": "number",
            "description": "Option Price\nOfficial example: 5000",
            "minimum": 1,
            "maximum": 999999999
          },
          "Qty": {
            "type": "integer",
            "description": "Option Quantity \nOfficial example: 100",
            "minimum": 0,
            "maximum": 2147483647
          }
        },
        "required": [
          "ItemCode",
          "OptionName",
          "OptionValue",
          "OptionCode"
        ],
        "additionalProperties": false,
        "description": "Update Inventory Data Unit\nOfficial QAPI method 10021; version 1.0.\n상품의 조합형옵션정보의 개별항목을 수정하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsOptions.UpdateInventoryQtyUnit": {
      "id": 10022,
      "version": "1.0",
      "risk": "H",
      "description": "Update Inventory Qty Unit",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "OptionName": {
            "type": "string",
            "description": "Option Name \nOfficial example: カラー、サイズ",
            "maxLength": 50,
            "minLength": 1
          },
          "OptionValue": {
            "type": "string",
            "description": "Option Value \nOfficial example: RED,S,M,L",
            "maxLength": 50,
            "minLength": 1
          },
          "OptionCode": {
            "type": "string",
            "description": "Option code \nOfficial example: Red_S",
            "maxLength": 50,
            "minLength": 1
          },
          "Qty": {
            "type": "integer",
            "description": "Option Quantity \nOfficial example: 100",
            "minimum": 0,
            "maximum": 2147483647
          }
        },
        "required": [
          "ItemCode",
          "OptionName",
          "OptionValue",
          "OptionCode"
        ],
        "additionalProperties": false,
        "description": "Update Inventory Qty Unit\nOfficial QAPI method 10022; version 1.0.\n상품의 조합형옵션정보의 옵션별 수량항목을 수정하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsOptions.UpdateInventoryQtyPlusUnit": {
      "id": 10023,
      "version": "1.0",
      "risk": "H",
      "description": "Update Inventory Qty Plus Unit",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "OptionName": {
            "type": "string",
            "description": "Option Name \nOfficial example: カラー、サイズ",
            "maxLength": 50,
            "minLength": 1
          },
          "OptionValue": {
            "type": "string",
            "description": "Option Value \nOfficial example: RED,S,M,L",
            "maxLength": 50,
            "minLength": 1
          },
          "OptionCode": {
            "type": "string",
            "description": "Option code \nOfficial example: Red_S",
            "maxLength": 50,
            "minLength": 1
          },
          "PlusQty": {
            "type": "integer",
            "description": "Variation\nQuantity to add to or subtract from\nOfficial example: in case of -1, it subtracts 1 from the current quantity",
            "minimum": -2147483648,
            "maximum": 2147483647
          }
        },
        "required": [
          "ItemCode",
          "OptionName",
          "OptionValue",
          "OptionCode"
        ],
        "additionalProperties": false,
        "description": "Update Inventory Qty Plus Unit\nOfficial QAPI method 10023; version 1.0.\n상품의 조합형옵션정보의 옵션별 수량항목을 수정하기 위한 API 메소드입니다.(현재수량 기준 가감계산)"
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsOptions.InsertInventoryDataBulk": {
      "id": 15236,
      "version": "1.0",
      "risk": "H",
      "description": "Insert Inventory Data Bulk",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemInfoJson": {
            "type": "array",
            "minItems": 1,
            "maxItems": 10,
            "description": "Option Information (Max 500)\nOfficial example: [{\"ItemCode\":\"String\",\"SellerCode\":\"String\",\"OptionName\":\"String||*String\",\"OptionValue\":\"String||*String\",\"OptionCode\":\"String||*String\",\"Price\":String,\"Qty\":String},{\"ItemCode\":\"String\",\"SellerCode\":\"String\",\"OptionName\":\"String||*String\",\"OptionValue\":\"St\n\nPass a typed array; the connector serializes it to the documented JSON string.",
            "items": {
              "type": "object",
              "properties": {
                "ItemCode": {
                  "type": "string",
                  "description": "The item code of Qoo10\nOfficial example: 1234567890",
                  "maxLength": 10,
                  "minLength": 1,
                  "pattern": "^[1-9][0-9]{0,9}$"
                },
                "SellerCode": {
                  "type": "string",
                  "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
                  "maxLength": 100
                },
                "OptionName": {
                  "type": "string",
                  "description": "Option Name \nOfficial example: カラー、サイズ",
                  "maxLength": 50,
                  "minLength": 1
                },
                "OptionValue": {
                  "type": "string",
                  "description": "Option Value \nOfficial example: RED,S,M,L",
                  "maxLength": 50,
                  "minLength": 1
                },
                "OptionCode": {
                  "type": "string",
                  "description": "Option code \nOfficial example: Red_S",
                  "maxLength": 50
                },
                "Price": {
                  "type": "string",
                  "maxLength": 32,
                  "pattern": "^-?[0-9]+(?:\\.[0-9]+)?$",
                  "description": "Option Price\nOfficial example: 5000"
                },
                "Qty": {
                  "type": "string",
                  "maxLength": 32,
                  "pattern": "^-?[0-9]+(?:\\.[0-9]+)?$",
                  "description": "Option Quantity \nOfficial example: 100"
                }
              },
              "required": [
                "ItemCode",
                "OptionName",
                "OptionValue"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "ItemInfoJson"
        ],
        "additionalProperties": false,
        "description": "Insert Inventory Data Bulk\nOfficial QAPI method 15236; version 1.0.\nQoo10에 등록한 복수 상품에 조합형 옵션정보를 추가 등록하기 위한 API 메소드입니다."
      },
      "batch": {
        "field": "ItemInfoJson",
        "kind": "unverified_dictionary"
      },
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$Count": "Int32",
        "ResultObject$$Keys$$Count": "Int32",
        "ResultObject$$Values$$Count": "Int32"
      },
      "xml": false
    },
    "ItemsOptions.UpdateInventoryDataBulk": {
      "id": 15237,
      "version": "1.0",
      "risk": "H",
      "description": "Update Inventory Data Bulk",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemInfoJson": {
            "type": "array",
            "minItems": 1,
            "maxItems": 10,
            "description": "Option Information (Max 500)\nOfficial example: [{\"ItemCode\":\"String\",\"SellerCode\":\"String\",\"OptionName\":\"String||*String\",\"OptionValue\":\"String||*String\",\"OptionCode\":\"String||*String\",\"Price\":String,\"Qty\":String},{\"ItemCode\":\"String\",\"SellerCode\":\"String\",\"OptionName\":\"String||*String\",\"OptionValue\":\"St\nPass a typed array; the connector serializes it to the documented JSON string.",
            "items": {
              "type": "object",
              "properties": {
                "ItemCode": {
                  "type": "string",
                  "description": "The item code of Qoo10\nOfficial example: 1234567890",
                  "maxLength": 10,
                  "minLength": 1,
                  "pattern": "^[1-9][0-9]{0,9}$"
                },
                "SellerCode": {
                  "type": "string",
                  "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
                  "maxLength": 100
                },
                "OptionName": {
                  "type": "string",
                  "description": "Option Name \nOfficial example: カラー、サイズ",
                  "maxLength": 50,
                  "minLength": 1
                },
                "OptionValue": {
                  "type": "string",
                  "description": "Option Value \nOfficial example: RED,S,M,L",
                  "maxLength": 50,
                  "minLength": 1
                },
                "OptionCode": {
                  "type": "string",
                  "description": "Option code \nOfficial example: Red_S",
                  "maxLength": 50,
                  "minLength": 1
                },
                "Price": {
                  "type": "string",
                  "maxLength": 32,
                  "pattern": "^-?[0-9]+(?:\\.[0-9]+)?$",
                  "description": "Option Price\nOfficial example: 5000"
                },
                "Qty": {
                  "type": "string",
                  "maxLength": 32,
                  "pattern": "^-?[0-9]+(?:\\.[0-9]+)?$",
                  "description": "Option Quantity \nOfficial example: 100"
                }
              },
              "required": [
                "ItemCode",
                "OptionName",
                "OptionValue",
                "OptionCode"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "ItemInfoJson"
        ],
        "additionalProperties": false,
        "description": "Update Inventory Data Bulk\nOfficial QAPI method 15237; version 1.0.\n복수 상품의 조합형옵션정보의 개별항목을 수정하기 위한 API 메소드입니다."
      },
      "batch": {
        "field": "ItemInfoJson",
        "kind": "unverified_dictionary"
      },
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$Count": "Int32",
        "ResultObject$$Keys$$Count": "Int32",
        "ResultObject$$Values$$Count": "Int32"
      },
      "xml": false
    },
    "ItemsOptions.EditMoveGoodsInventory": {
      "id": 15762,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Move Goods Inventory",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "商品番号(半角数字)\n\n例) 1234567890\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "販売者商品コード\n[ガイド] 販売者商品コードは同一アカウント内で重複させることはできません。\n\n最大100文字\n\n販売者の管理用商品コード\nOfficial example: A12345b",
            "maxLength": 100
          },
          "OptionQty": {
            "type": "string",
            "description": "オプション別在庫数量\nサイズがある場合\nオプション名||*サイズ名||*在庫数量||*販売者オプションコード$$\n\nサイズがない場合\nオプション名||*在庫数量||*販売者オプションコード$$\nOfficial example: 例1)サイズあり\nブラック||*S||*200||*BLACK-S\n例2)サイズなし\nブラック||*200||*BLACK$$\nレッド||*200||*RED$$\nブルー||*200||*BLUE",
            "maxLength": 262144
          }
        },
        "required": [
          "ItemCode"
        ],
        "additionalProperties": false,
        "description": "Edit Move Goods Inventory\nOfficial QAPI method 15762; version 1.0.\n등록된 MOVE 상품의 재고를 수정하는 API Method 입니다."
      },
      "batch": null,
      "row_fields": [
        "OptionQty"
      ],
      "date_fields": [],
      "output_kind": "undocumented",
      "output_types": {},
      "xml": false
    },
    "ItemsOptions.EditCommonGoodsInventory": {
      "id": 15763,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Common Goods Inventory",
      "input_schema": {
        "type": "object",
        "properties": {
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100,
            "minLength": 1
          },
          "InventoryInfo": {
            "type": "string",
            "description": "Combined Option Information\nYou can set the combined option that has the price and inventory information by each option using these parameters.\nInput format : Column separator(||*), Row separator($$) -->[Option name 1]||*[Option detail 1]||*[Price]||*[QTY]||*[Option Code 1]$$[Option name 1]||*[Option detail 2]||*[Price]||*[QTY]||*[Option Code 2]\nOfficial example: 例：マウス1の価格が100円で在庫数が10個、マウス2の価格が200円で在庫が20個。ex）&InventoryInfo =マウス||*マウス1||*100||*10||*M1$$マウス||*マウス2||*100||*10||*M2",
            "maxLength": 262144
          }
        },
        "required": [
          "SellerCode"
        ],
        "additionalProperties": false,
        "description": "Edit Common Goods Inventory\nOfficial QAPI method 15763; version 1.0.\n등록된 일반 상품과 MOVE 상품의 재고를 함께 수정하는 API Method 입니다."
      },
      "batch": null,
      "row_fields": [
        "InventoryInfo"
      ],
      "date_fields": [],
      "output_kind": "undocumented",
      "output_types": {},
      "xml": false
    },
    "ItemsContents.EditGoodsContents": {
      "id": 10027,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Goods Contents",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "Contents": {
            "type": "string",
            "description": "The detailed contents of the item\nThis will be exposed in the area of the detailed content of the item.\nOfficial example: <img src=\"https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png\">",
            "maxLength": 262144,
            "minLength": 1
          }
        },
        "required": [
          "ItemCode",
          "Contents"
        ],
        "additionalProperties": false,
        "description": "Edit Goods Contents\nOfficial QAPI method 10027; version 1.0.\nQoo10에 등록한 상품의 상세내용을 수정하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsContents.EditGoodsImage": {
      "id": 10028,
      "version": "1.1",
      "risk": "H",
      "description": "Edit Goods Image",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "StandardImage": {
            "type": "string",
            "description": "URL of the image\nThis will be displayed as the main image of the item.\nOfficial example: https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png",
            "maxLength": 200,
            "minLength": 1
          },
          "VideoURL": {
            "type": "string",
            "description": "VideoURL for Item Image\nOfficial example: https://www.youtube.com/watch?v=Zhl4N5vd7NE",
            "maxLength": 200
          }
        },
        "required": [
          "ItemCode",
          "StandardImage"
        ],
        "additionalProperties": false,
        "description": "Edit Goods Image\nOfficial QAPI method 10028; version 1.1.\nQoo10에 등록한 상품의 메인 이미지를 수정하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsContents.EditGoodsMultiImage": {
      "id": 10029,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Goods Multi Image",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "EnlargedImage1": {
            "type": "string",
            "description": "URLs of the multiple images\nThese will be exposed in the contents of the item.\nOfficial example:  https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png$$\nhttps://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png\n",
            "maxLength": 200
          },
          "EnlargedImage2": {
            "type": "string",
            "description": "URLs of the multiple images\nThese will be exposed in the contents of the item.\nOfficial example:  https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png$$\nhttps://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png",
            "maxLength": 200
          },
          "EnlargedImage3": {
            "type": "string",
            "description": "URLs of the multiple images\nThese will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage4": {
            "type": "string",
            "description": "URLs of the multiple images\nThese will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage5": {
            "type": "string",
            "description": "URLs of the multiple images\nThese will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage6": {
            "type": "string",
            "description": "URLs of the multiple images\nThese will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage7": {
            "type": "string",
            "description": "URLs of the multiple images\nThese will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage8": {
            "type": "string",
            "description": "URLs of the multiple images\nThese will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage9": {
            "type": "string",
            "description": "URLs of the multiple images\nThese will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage10": {
            "type": "string",
            "description": "URLs of the multiple images\nThese will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage11": {
            "type": "string",
            "description": "URLs of the multiple images\nThese will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage12": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.\n",
            "maxLength": 200
          },
          "EnlargedImage13": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage14": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage15": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage16": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage17": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage18": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage19": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage20": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage21": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage22": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage23": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage24": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage25": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage26": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage27": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage28": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage29": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage30": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage31": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage32": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage33": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage34": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage35": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage36": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage37": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage38": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage39": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage40": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage41": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage42": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage43": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage44": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage45": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage46": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage47": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage48": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage49": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          },
          "EnlargedImage50": {
            "type": "string",
            "description": "URLs of the multiple images. These will be exposed in the contents of the item.",
            "maxLength": 200
          }
        },
        "required": [
          "ItemCode"
        ],
        "additionalProperties": false,
        "description": "Edit Goods Multi Image\nOfficial QAPI method 10029; version 1.0.\n상품의 멀티 이미지를 수정하는 Method 입니다."
      },
      "batch": null,
      "row_fields": [
        "EnlargedImage1",
        "EnlargedImage2"
      ],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsContents.EditGoodsHeaderFooter": {
      "id": 10030,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Goods Header Footer",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "EditHeaderYN": {
            "type": "string",
            "description": "Status of editing the header\nOfficial example: 修正が必要な場合= Y、必要が無い場合= N",
            "maxLength": 1,
            "minLength": 1,
            "enum": [
              "Y",
              "N"
            ]
          },
          "Header": {
            "type": "string",
            "description": "String that will be inserted in the header\nThis is the text will be exposed in the top of the contents of the item page.\nOfficial example: <img src=\"https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png\">",
            "maxLength": 2500
          },
          "EditFooterYN": {
            "type": "string",
            "description": "Status of editing the footer\nOfficial example: 修正が必要な場合= Y、必要が無い場合= N",
            "maxLength": 1,
            "minLength": 1,
            "enum": [
              "Y",
              "N"
            ]
          },
          "Footer": {
            "type": "string",
            "description": "String that will be inserted in the footer\nThis is the text will be exposed in the bottom of the contents of the item page.\nOfficial example: <img src=\"https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png\">",
            "maxLength": 2500
          }
        },
        "required": [
          "ItemCode",
          "EditHeaderYN",
          "EditFooterYN"
        ],
        "additionalProperties": false,
        "description": "Edit Goods Header Footer\nOfficial QAPI method 10030; version 1.0.\n상품상세 컨텐츠 영역의 헤더와 풋터를 수정하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsContents.EditAdditionalOptionImage": {
      "id": 15783,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Additional Option Image",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "AdditionalOptionImage": {
            "type": "string",
            "description": "複数の追加オプション画像を登録/修正することができます。<br>\n$$ によりそれぞれの画像を区分<br>\nオプション名1||*オプションの値1||*画像URL1$$オプション名2||*オプションの値2||*画像URL2\nOfficial example: 乾電池||*4本セット||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png",
            "maxLength": 262144
          }
        },
        "required": [
          "ItemCode"
        ],
        "additionalProperties": false,
        "description": "Edit Additional Option Image\nOfficial QAPI method 15783; version 1.0.\n상품의 추가 구성 이미지를 수정하기 위한 API입니다."
      },
      "batch": null,
      "row_fields": [
        "AdditionalOptionImage"
      ],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsContents.EditInventoryImage": {
      "id": 15784,
      "version": "1.0",
      "risk": "H",
      "description": "Edit Inventory Image",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "The item code of Qoo10\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100
          },
          "InventoryImage": {
            "type": "string",
            "description": "複数のオプション画像を登録/修正することができます。<br>\n$$ によりそれぞれの画像を区分<br>\nオプション名1||*オプションの値1||*画像URL1$$オプション名2||*オプションの値2||*画像URL2\nOfficial example: Red||*Mサイズ||*https://dp.image-qoo10.jp/GMKT.IMG/loading_2017/qoo10_loading.v_20170420.png",
            "maxLength": 262144
          }
        },
        "required": [
          "ItemCode"
        ],
        "additionalProperties": false,
        "description": "Edit Inventory Image\nOfficial QAPI method 15784; version 1.0.\n상품의 옵션 이미지를 수정하기 위한 API입니다."
      },
      "batch": null,
      "row_fields": [
        "InventoryImage"
      ],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ItemsLookup.GetGoodsOptionInfo": {
      "id": 10004,
      "version": "1.0",
      "risk": "R",
      "description": "Get Goods Option Info",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "Qoo10 Item Code<br>\n* Required Input : 1 Item Code; either Qoo10 Item Code or Seller Item code\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100,
            "minLength": 1
          }
        },
        "required": [],
        "additionalProperties": false,
        "anyOf": [
          {
            "required": [
              "ItemCode"
            ]
          },
          {
            "required": [
              "SellerCode"
            ]
          }
        ],
        "description": "Get Goods Option Info\nOfficial QAPI method 10004; version 1.0.\nQoo10에 등록한 상품의 단일형 옵션정보를 조회하기 위한 API 메소드입니다.\n2016-04-28\n  - Method Notice Beta Open\n2016-05-03, Registered language resource"
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$Name": "String",
        "ResultObject$$Value": "String",
        "ResultObject$$Price": "Decimal",
        "ResultObject$$OptionCode": "String"
      },
      "xml": false
    },
    "ItemsLookup.GetGoodsInventoryInfo": {
      "id": 10005,
      "version": "1.0",
      "risk": "R",
      "description": "Get Goods Inventory Info",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "Qoo10 Item Code<br>\n* Required Input : 1 Item Code; either Qoo10 Item Code or Seller Item code\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100,
            "minLength": 1
          }
        },
        "required": [],
        "additionalProperties": false,
        "anyOf": [
          {
            "required": [
              "ItemCode"
            ]
          },
          {
            "required": [
              "SellerCode"
            ]
          }
        ],
        "description": "Get Goods Inventory Info\nOfficial QAPI method 10005; version 1.0.\nQoo10에 등록한 판매자 상품의 조합형 옵션정보를 조회하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$Name1": "String",
        "ResultObject$$Value1": "String",
        "ResultObject$$Name2": "String",
        "ResultObject$$Value2": "String",
        "ResultObject$$Name3": "String",
        "ResultObject$$Value3": "String",
        "ResultObject$$Name4": "String",
        "ResultObject$$Value4": "String",
        "ResultObject$$Name5": "String",
        "ResultObject$$Value5": "String",
        "ResultObject$$Price": "Decimal",
        "ResultObject$$Qty": "Int32",
        "ResultObject$$ItemTypeCode": "String"
      },
      "xml": false
    },
    "ItemsLookup.GetSellerDeliveryGroupInfo": {
      "id": 10006,
      "version": "1.0",
      "risk": "R",
      "description": "Get Seller Delivery Group Info",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false,
        "description": "Get Seller Delivery Group Info\nOfficial QAPI method 10006; version 1.0.\n판매자의 배송비정보를 조회하기 위한 API 메소드입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$ShippingNo": "Int32",
        "ResultObject$$ShippingFee": "Decimal",
        "ResultObject$$ShippingType": "String",
        "ResultObject$$FreeCondition": "Decimal",
        "ResultObject$$Region": "String",
        "ResultObject$$Oversea": "String",
        "ResultObject$$transcName": "String"
      },
      "xml": false
    },
    "ItemsLookup.GetItemDetailInfo": {
      "id": 10007,
      "version": "1.2",
      "risk": "R",
      "description": "Get Item Detail Info",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "Qoo10 Item Code\n* Required Input : 1 Item Code; either Qoo10 Item Code or Seller Item code\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "This is the item code managed by the seller. \nUsing this code, you can search or edit the information of the item after registering it. \nOfficial example: A12345b",
            "maxLength": 100,
            "minLength": 1
          }
        },
        "required": [],
        "additionalProperties": false,
        "anyOf": [
          {
            "required": [
              "ItemCode"
            ]
          },
          {
            "required": [
              "SellerCode"
            ]
          }
        ],
        "description": "Get Item Detail Info\nOfficial QAPI method 10007; version 1.2.\n상품 코드를 입력하여 단일 상품의 상품 정보를 조회하는 Method입니다.\n2015.05.03 안내 리소스 등록"
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$ItemCode": "String",
        "ResultObject$$ItemStatus": "String",
        "ResultObject$$ItemTitle": "String",
        "ResultObject$$PromotionName": "String",
        "ResultObject$$MainCatCd": "String",
        "ResultObject$$MainCatNm": "String",
        "ResultObject$$FirstSubCatCd": "String",
        "ResultObject$$FirstSubCatNm": "String",
        "ResultObject$$SecondSubCatCd": "String",
        "ResultObject$$SecondSubCatNm": "String",
        "ResultObject$$Drugtype": "String",
        "ResultObject$$SellerCode": "String",
        "ResultObject$$ProductionPlaceType": "String",
        "ResultObject$$ProductionPlace": "String",
        "ResultObject$$IndustrialCodeType": "String",
        "ResultObject$$IndustrialCode": "String",
        "ResultObject$$RetailPrice": "String",
        "ResultObject$$ItemPrice": "String",
        "ResultObject$$TaxRate": "String",
        "ResultObject$$SettlePrice": "String",
        "ResultObject$$ItemQty": "String",
        "ResultObject$$ExpireDate": "String",
        "ResultObject$$ModelNM": "String",
        "ResultObject$$ManufacturerDate": "String",
        "ResultObject$$BrandNo": "String",
        "ResultObject$$Material": "String",
        "ResultObject$$AdultYN": "String",
        "ResultObject$$DesiredShippingDate": "String",
        "ResultObject$$AvailableDateType": "String",
        "ResultObject$$AvailableDateValue": "String",
        "ResultObject$$ShippingNo": "String",
        "ResultObject$$ContactInfo": "String",
        "ResultObject$$ItemDetail": "String",
        "ResultObject$$ImageUrl": "String",
        "ResultObject$$VideoURL": "String",
        "ResultObject$$Keyword": "String",
        "ResultObject$$ListedDate": "String",
        "ResultObject$$ChangedDate": "String"
      },
      "xml": false
    },
    "ItemsLookup.GetAllGoodsInfo": {
      "id": 10008,
      "version": "1.0",
      "risk": "R",
      "description": "Get All Goods Info",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemStatus": {
            "type": "string",
            "description": "Status of the item's transaction\n(Waiting QA= S0, Transaction preparation = S1, Transaction available = S2, Transaction suspended = S3, Transaction Restricted = S5, Not approved = S8)\nOfficial example: S0",
            "maxLength": 2,
            "minLength": 1,
            "enum": [
              "S0",
              "S1",
              "S2",
              "S3",
              "S5",
              "S8"
            ]
          },
          "Page": {
            "type": "string",
            "description": "Page Number (If you don't input, it will be diplayed from page 1.)\nOfficial example: 1",
            "maxLength": 10,
            "pattern": "^[1-9][0-9]{0,9}$",
            "default": "1"
          }
        },
        "required": [
          "ItemStatus"
        ],
        "additionalProperties": false,
        "description": "Get All Goods Info\nOfficial QAPI method 10008; version 1.0.\n상품거래상태를 기준으로 판매자가 등록한 상품전체를 조회하기 위한 API 메소드입니다. <br> (한페이지에 최대 500개까지 상품이 조회되며, 페이지로 구분하여 조회할 수 있습니다.)\n2015.05.03 안내 리소스 등록"
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "object",
      "output_types": {
        "ResultObject$$TotalItems": "Int32",
        "ResultObject$$TotalPages": "Int32",
        "ResultObject$$PresentPage": "Int32",
        "ResultObject$$Items$$ItemCode": "String",
        "ResultObject$$Items$$SellerCode": "String",
        "ResultObject$$Items$$ItemStatus": "String"
      },
      "xml": false
    },
    "ItemsLookup.RequestFileDownload": {
      "id": 10040,
      "version": "1.0",
      "risk": "H",
      "description": "Request a product, inventory or order export",
      "input_schema": {
        "type": "object",
        "properties": {
          "apply_type": {
            "type": "string",
            "description": "Type (item, inventory, order, ship)\nOfficial example: item",
            "maxLength": 262144,
            "minLength": 1,
            "enum": [
              "item",
              "inventory",
              "order",
              "ship"
            ]
          },
          "email": {
            "type": "string",
            "description": "Email (when completed)",
            "maxLength": 100
          },
          "target_from_dt": {
            "type": "string",
            "description": "Standard Starting Date (YYYY/MM/DD)\nOfficial example: 2000/01/11",
            "maxLength": 10
          },
          "target_to_dt": {
            "type": "string",
            "description": "Standard Closing Date (YYYY/MM/DD)\nOfficial example: 2000/01/11",
            "maxLength": 10
          }
        },
        "required": [
          "apply_type"
        ],
        "additionalProperties": false,
        "description": "Request a product, inventory or order export\nOfficial QAPI method 10040; version 1.0.\n정보(item, inventory, order, ship)를 다운로드 하는 Method입니다"
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$DownloadType": "String",
        "ResultObject$$DownloadURL": "String",
        "ResultObject$$DownloadExplain": "String"
      },
      "xml": false
    },
    "ItemsLookup.GetMoveItemDetailInfo": {
      "id": 15761,
      "version": "1.0",
      "risk": "R",
      "description": "Get Move Item Detail Info",
      "input_schema": {
        "type": "object",
        "properties": {
          "ItemCode": {
            "type": "string",
            "description": "商品番号(半角数字)\n\n例) 1234567890\nOfficial example: 1234567890",
            "maxLength": 10,
            "minLength": 1,
            "pattern": "^[1-9][0-9]{0,9}$"
          },
          "SellerCode": {
            "type": "string",
            "description": "販売者商品コード\n[ガイド] 販売者商品コードは同一アカウント内で重複させることはできません。\n\n最大100文字\n\n販売者の管理用商品コード\nOfficial example: A12345b",
            "maxLength": 100
          }
        },
        "required": [
          "ItemCode"
        ],
        "additionalProperties": false,
        "description": "Get Move Item Detail Info\nOfficial QAPI method 15761; version 1.0.\nMOVE 상품코드를 입력하여 단일상품의 상세 정보를 조회하는 API Method 입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "undocumented",
      "output_types": {},
      "xml": false
    },
    "ShippingBasic.GetShippingInfo_v3": {
      "id": 15766,
      "version": "1.0",
      "risk": "R",
      "description": "Get Shipping Info_v3",
      "input_schema": {
        "type": "object",
        "properties": {
          "ShippingStatus": {
            "type": "string",
            "description": "Shipping Status Code 1: Delivery Preparation 2: Delivery Requested 3:  Delivery Confirmed 4: On delivery 5: Delivery complete <br> *0 or blank: 1&2\n\nOfficial example: 1",
            "maxLength": 1,
            "enum": [
              "0",
              "1",
              "2",
              "3",
              "4",
              "5"
            ]
          },
          "SearchStartDate": {
            "type": "string",
            "description": "Start date to search dispatch\n 20230101(yyyyMMdd), 20230101153000(yyyyMMddHHmmss)\nOfficial example:  20230101",
            "maxLength": 14,
            "pattern": "^[0-9]{8}([0-9]{6})?$"
          },
          "SearchEndDate": {
            "type": "string",
            "description": "End date to search dispatch\n20230101(yyyyMMdd), 20230101153000(yyyyMMddHHmmss)\nOfficial example: 20230101",
            "maxLength": 14,
            "pattern": "^[0-9]{8}([0-9]{6})?$"
          },
          "SearchCondition": {
            "type": "string",
            "description": "Search condition(1：Order Date、2：Payment Date、3：Delivery start Date、4：Delivered Date) \nOfficial example: 2",
            "maxLength": 1,
            "enum": [
              "1",
              "2",
              "3",
              "4"
            ]
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Get Shipping Info_v3\nOfficial QAPI method 15766; version 1.0.\n판매자의 배송상태 정보를 조회하는 Method 입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [
        "SearchStartDate",
        "SearchEndDate"
      ],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$ShippingStatus": "String",
        "ResultObject$$SellerID": "String",
        "ResultObject$$PackNo": "Int32",
        "ResultObject$$OrderDate": "String",
        "ResultObject$$PaymentDate": "String",
        "ResultObject$$EstimatedShippingDate": "String",
        "ResultObject$$ShippingDate": "String",
        "ResultObject$$DeliveredDate": "String",
        "ResultObject$$Buyer": "String",
        "ResultObject$$BuyerKana": "String",
        "ResultObject$$BuyerTel": "String",
        "ResultObject$$BuyerMobile": "String",
        "ResultObject$$BuyerEmail": "String",
        "ResultObject$$OrderNo": "Int32",
        "ResultObject$$ItemNo": "String",
        "ResultObject$$SellerItemCode": "String",
        "ResultObject$$ItemTitle": "String",
        "ResultObject$$Option": "String",
        "ResultObject$$OptionCode": "String",
        "ResultObject$$OrderPrice": "Decimal",
        "ResultObject$$OrderQty": "Int32",
        "ResultObject$$Discount": "Decimal",
        "ResultObject$$Total": "Decimal",
        "ResultObject$$Receiver": "String",
        "ResultObject$$ReceiverKana": "String",
        "ResultObject$$ZipCode": "String",
        "ResultObject$$ShippingAddress": "String",
        "ResultObject$$Address1": "String",
        "ResultObject$$Address2": "String",
        "ResultObject$$ReceiverTel": "String",
        "ResultObject$$ReceiverMobile": "String",
        "ResultObject$$DesiredDeliveryDate": "String",
        "ResultObject$$SenderName": "String",
        "ResultObject$$SenderTel": "String",
        "ResultObject$$SenderNation": "String",
        "ResultObject$$SenderZipCode": "String",
        "ResultObject$$SenderAddress": "String",
        "ResultObject$$ShippingWay": "String",
        "ResultObject$$ShippingMessage": "String",
        "ResultObject$$PaymentMethod": "String",
        "ResultObject$$SellerDiscount": "Decimal",
        "ResultObject$$Currency": "String",
        "ResultObject$$ShippingRate": "Decimal",
        "ResultObject$$RelatedOrder": "String",
        "ResultObject$$ShippingRateType": "String",
        "ResultObject$$DeliveryCompany": "String",
        "ResultObject$$VoucherCode": "String",
        "ResultObject$$PackingNo": "String",
        "ResultObject$$SellerDeliveryNo": "String",
        "ResultObject$$Gift": "String",
        "ResultObject$$CartDiscountSeller": "Decimal",
        "ResultObject$$CartDiscountQoo10": "Decimal",
        "ResultObject$$SettlePrice": "Decimal",
        "ResultObject$$BranchName": "String",
        "ResultObject$$TrackingNo": "String",
        "ResultObject$$Material": "String",
        "ResultObject$$AvailableSendType": "String",
        "ResultObject$$AvailableShippingDate": "String"
      },
      "xml": false
    },
    "ShippingBasic.SetSellerCheckYN_V2": {
      "id": 10050,
      "version": "1.0",
      "risk": "H",
      "description": "Set Seller Check YN_V2",
      "input_schema": {
        "type": "object",
        "properties": {
          "OrderNo": {
            "type": "string",
            "description": "Order number\nOfficial example: 110066710",
            "maxLength": 262144,
            "minLength": 1
          },
          "EstShipDt": {
            "type": "string",
            "description": "Esitmated shipping date\n20190101 (yyyyMMdd)\nOfficial example: 20190101",
            "maxLength": 14,
            "pattern": "^[0-9]{8}$"
          },
          "DelayType": {
            "type": "string",
            "description": "Reason for delay Type((1: Preparing the product, 2: making it to order (made to order), 3: requesting the customer, 4: etc.)\nOfficial example: 1",
            "maxLength": 1
          },
          "DelayMemo": {
            "type": "string",
            "description": "Seller's memo about delay\nOfficial example: 不在の場合は管理室に預けてください。",
            "maxLength": 1000
          }
        },
        "required": [
          "OrderNo"
        ],
        "additionalProperties": false,
        "description": "Set Seller Check YN_V2\nOfficial QAPI method 10050; version 1.0.\n발주확인 상태를 변경하는 Method입니다"
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [
        "EstShipDt"
      ],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ShippingBasic.SetSellerCheckYNBulk": {
      "id": 15772,
      "version": "1.0",
      "risk": "H",
      "description": "Set Seller Check YNBulk",
      "input_schema": {
        "type": "object",
        "properties": {
          "SendPlanDtInfoJson": {
            "type": "array",
            "minItems": 1,
            "maxItems": 10,
            "description": "JSON形式の 注文番号, 発送予定日, 遅延の理由。, 販売者メモ<br>\n[{\"OrderNo\":\"String\",\"EstShipDt\":\"String\",\"DelayType\":\"String\",\"DelayMemo\":\"String\"},{\"OrderNo\":\"String\", \"EstShipDt\":\"String\",\"DelayType\":\"String\",\"DelayMemo\":\"String\"},{\"OrderNo\":\"String\", \"EstShipDt\":\"String\",\"DelayType\":\"String\",\"DelayMemo\":\"String\"}]<br><br>\n- 注文番号 : 最大500個<br>\n- 発送予定日 : YYYYMMDD<br>\n- 遅延の理由。（1：商品準備中、2：注文製作（オーダーメイド）、3：顧客の要求、4：その他）\nOfficial example:  [{\"OrderNo\":\"123400000\",\"EstShipDt\":\"20240101\",\"DelayType\":\"\",\"DelayMemo\":\"\" },{\"OrderNo\":\"567800000\", \"EstShipDt\":\"20240101\",\"DelayType\":\"3\",\"DelayMemo\":\"TEST\"}]\nPass a typed array; the connector serializes it to the documented JSON string.",
            "items": {
              "type": "object",
              "properties": {
                "OrderNo": {
                  "type": "string",
                  "description": "Order number\nOfficial example: 110066710",
                  "maxLength": 262144,
                  "minLength": 1
                },
                "EstShipDt": {
                  "type": "string",
                  "description": "Esitmated shipping date\n20190101 (yyyyMMdd)\nOfficial example: 20190101",
                  "maxLength": 8
                },
                "DelayType": {
                  "type": "string",
                  "description": "Reason for delay Type((1: Preparing the product, 2: making it to order (made to order), 3: requesting the customer, 4: etc.)\nOfficial example: 1",
                  "maxLength": 1
                },
                "DelayMemo": {
                  "type": "string",
                  "description": "Seller's memo about delay\nOfficial example: 不在の場合は管理室に預けてください。",
                  "maxLength": 1000
                }
              },
              "required": [
                "OrderNo"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "SendPlanDtInfoJson"
        ],
        "additionalProperties": false,
        "description": "Set Seller Check YNBulk\nOfficial QAPI method 15772; version 1.0.\n발주확인 상태를 변경하는 Method입니다"
      },
      "batch": {
        "field": "SendPlanDtInfoJson",
        "kind": "confirmation"
      },
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultObject$$cont_no": "Int32",
        "ResultObject$$result_cd": "Int32",
        "ResultCode": "Int32",
        "ResultMsg": "Int32"
      },
      "xml": false
    },
    "ShippingBasic.SetSendingInfo": {
      "id": 10042,
      "version": "1.0",
      "risk": "H",
      "description": "Set Sending Info",
      "input_schema": {
        "type": "object",
        "properties": {
          "OrderNo": {
            "type": "string",
            "description": "Order Number\nOfficial example: 1062428737",
            "maxLength": 262144,
            "minLength": 1
          },
          "ShippingCorp": {
            "type": "string",
            "description": "Shipping Company\nOfficial example: ゆうパック",
            "maxLength": 200,
            "minLength": 1
          },
          "TrackingNo": {
            "type": "string",
            "description": "Tracking number\nOfficial example: 1234567890AA",
            "maxLength": 50,
            "minLength": 1
          }
        },
        "required": [
          "OrderNo",
          "ShippingCorp",
          "TrackingNo"
        ],
        "additionalProperties": false,
        "description": "Set Sending Info\nOfficial QAPI method 10042; version 1.0.\n배송 요청건에 대해 발송확인 처리를 하는 Method 입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "ShippingBasic.SetSendingInfoBulk": {
      "id": 15773,
      "version": "1.0",
      "risk": "H",
      "description": "Set Sending Info Bulk",
      "input_schema": {
        "type": "object",
        "properties": {
          "ShippingInfoJson": {
            "type": "array",
            "minItems": 1,
            "maxItems": 10,
            "description": "JSON形式の 注文番号, 配送会社, 送り状番号<br>\n[{\"OrderNo\":string,\"ShippingCorp\":string,\"TrackingNo\":string},{\"OrderNo\":string,\"ShippingCorp\":string,\"TrackingNo\":string},{\"OrderNo\":string,\"ShippingCorp\":string,\"TrackingNo\":string}]<br><br>\nOfficial example: [{\"OrderNo\":\"123400000\",\"ShippingCorp\":\"Qxpress\",\"TrackingNo\":\"A1234567890\"},{\"OrderNo\":\"567800000\",\"ShippingCorp\":\"Qxpress\",\"TrackingNo\":\"B1234567890\"}]\nPass a typed array; the connector serializes it to the documented JSON string.",
            "items": {
              "type": "object",
              "properties": {
                "OrderNo": {
                  "type": "string",
                  "description": "Order Number\nOfficial example: 1062428737",
                  "maxLength": 262144,
                  "minLength": 1
                },
                "ShippingCorp": {
                  "type": "string",
                  "description": "Shipping Company\nOfficial example: ゆうパック",
                  "maxLength": 200,
                  "minLength": 1
                },
                "TrackingNo": {
                  "type": "string",
                  "description": "Tracking number\nOfficial example: 1234567890AA",
                  "maxLength": 50,
                  "minLength": 1
                }
              },
              "required": [
                "OrderNo",
                "ShippingCorp",
                "TrackingNo"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "ShippingInfoJson"
        ],
        "additionalProperties": false,
        "description": "Set Sending Info Bulk\nOfficial QAPI method 15773; version 1.0.\n배송 요청건에 대해 발송확인 처리를 하는 Method 입니다."
      },
      "batch": {
        "field": "ShippingInfoJson",
        "kind": "shipping"
      },
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultObject$$contr_no": "Int32",
        "ResultObject$$result_cd": "Int32",
        "ResultObject$$transc_nm": "Int32",
        "ResultCode": "Int32",
        "ResultMsg": "Int32"
      },
      "xml": false
    },
    "ShippingBasic.GetShippingAndClaimInfoByOrderNo_V2": {
      "id": 15477,
      "version": "1.0",
      "risk": "R",
      "description": "Get Shipping And Claim Info By Order No_V2",
      "input_schema": {
        "type": "object",
        "properties": {
          "OrderNo": {
            "type": "string",
            "description": "Order number\nOfficial example: 1000000000",
            "maxLength": 10,
            "minLength": 1
          }
        },
        "required": [
          "OrderNo"
        ],
        "additionalProperties": false,
        "description": "Get Shipping And Claim Info By Order No_V2\nOfficial QAPI method 15477; version 1.0.\n판매자의 주문단일건의 배송/클레임 정보를 조회하는 Method 입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$shippingStatus": "String",
        "ResultObject$$sellerID": "String",
        "ResultObject$$packNo": "Int32",
        "ResultObject$$orderDate": "String",
        "ResultObject$$PaymentDate": "String",
        "ResultObject$$DeliveredDate": "String",
        "ResultObject$$buyer": "String",
        "ResultObject$$buyer_gata": "String",
        "ResultObject$$buyerTel": "String",
        "ResultObject$$buyerMobile": "String",
        "ResultObject$$buyerEmail": "String",
        "ResultObject$$OrderType": "String",
        "ResultObject$$orderNo": "Int32",
        "ResultObject$$itemCode": "String",
        "ResultObject$$sellerItemCode": "String",
        "ResultObject$$itemTitle": "String",
        "ResultObject$$option": "String",
        "ResultObject$$optionCode": "String",
        "ResultObject$$orderPrice": "Decimal",
        "ResultObject$$orderQty": "Int32",
        "ResultObject$$discount": "Decimal",
        "ResultObject$$total": "Decimal",
        "ResultObject$$receiver": "String",
        "ResultObject$$receiver_gata": "String",
        "ResultObject$$shippingCountry": "String",
        "ResultObject$$zipCode": "String",
        "ResultObject$$shippingAddr": "String",
        "ResultObject$$receiverTel": "String",
        "ResultObject$$receiverMobile": "String",
        "ResultObject$$hopeDate": "String",
        "ResultObject$$senderName": "String",
        "ResultObject$$senderTel": "String",
        "ResultObject$$senderNation": "String",
        "ResultObject$$senderZipCode": "String",
        "ResultObject$$senderAddr": "String",
        "ResultObject$$ShippingWay": "String",
        "ResultObject$$ShippingMsg": "String",
        "ResultObject$$shippingRateType": "String",
        "ResultObject$$PackingNo": "String",
        "ResultObject$$SellerDeliveryNo": "String",
        "ResultObject$$VoucherCode": "String",
        "ResultObject$$paymentNation": "String",
        "ResultObject$$PaymentMethod": "String",
        "ResultObject$$Gift": "String",
        "ResultObject$$cod_price": "Decimal",
        "ResultObject$$Cart_Discount_Seller": "Decimal",
        "ResultObject$$Cart_Discount_Qoo10": "Decimal",
        "ResultObject$$claimStatus": "String",
        "ResultObject$$cancelRefundDate": "String",
        "ResultObject$$reason": "String",
        "ResultObject$$requestDate": "String",
        "ResultObject$$shippingDate": "String",
        "ResultObject$$currency": "String",
        "ResultObject$$deliveryCompany": "String",
        "ResultObject$$trackingNo": "String",
        "ResultObject$$deliveryCompanyReturn": "String",
        "ResultObject$$trackingNoReturn": "String",
        "ResultObject$$pickupAddress": "String",
        "ResultObject$$pickupzipCode": "String",
        "ResultObject$$paymentReturnShipping": "String",
        "ResultObject$$itemCondition": "String",
        "ResultObject$$CODCancelPrice": "Decimal",
        "ResultObject$$CODQrefundPrice": "Decimal",
        "ResultObject$$CODCancelRelatedOrder": "String",
        "ResultObject$$nrDutyTarget": "String",
        "ResultObject$$nrSolType": "String",
        "ResultObject$$nrPartRefundCnt": "Int32",
        "ResultObject$$nrPartRefundBalance": "Decimal"
      },
      "xml": false
    },
    "ShippingBasic.GetClaimInfo_V3": {
      "id": 15475,
      "version": "1.0",
      "risk": "R",
      "description": "Get Claim Info_V3",
      "input_schema": {
        "type": "object",
        "properties": {
          "ClaimStat": {
            "type": "string",
            "description": "Claim Status Code<br/>\n1.Cancel Request<br/>\n2.Cancelling<br/>\n3.Cancel Completed<br/>\n4.Return Request<br/>\n5.Returning<br/>\n6.Return completed<br/>\n11.Exchange Request<br/>\n12.Exchange Approve<br/>\n13.Re-delivering<br/>\n14.Non-Receipt Refund Completed<br/>\n15.Non-Receipt Part Refund Completed<br/>\n16.Unpaid Order Cancel\nOfficial example: 1",
            "maxLength": 262144
          },
          "search_Sdate": {
            "type": "string",
            "description": "Request date for Cancellation/Refund/Replacement : Start date to search\nOfficial example: 20190101 (yyyyMMdd), 20190101153000 (yyyyMMddHHmmss)",
            "maxLength": 14,
            "minLength": 1,
            "pattern": "^[0-9]{8}([0-9]{6})?$"
          },
          "search_Edate": {
            "type": "string",
            "description": "Request date for Cancellation/Refund/Replacement : End date to search\nOfficial example: 20190101 (yyyyMMdd), 20190101153000 (yyyyMMddHHmmss)",
            "maxLength": 14,
            "minLength": 1,
            "pattern": "^[0-9]{8}([0-9]{6})?$"
          },
          "search_condition": {
            "type": "string",
            "description": "Searching date condition<br/>\n1 : Order date <br/>\n2 : Request date<br/>\n3 : Cancelled/Refunded \nOfficial example: 1",
            "maxLength": 1,
            "enum": [
              "1",
              "2",
              "3"
            ]
          }
        },
        "required": [
          "search_Sdate",
          "search_Edate"
        ],
        "additionalProperties": false,
        "description": "Get Claim Info_V3\nOfficial QAPI method 15475; version 1.0.\n판매자의 클레임상태를 조회하는 Method 입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [
        "search_Sdate",
        "search_Edate"
      ],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$claimStatus": "String",
        "ResultObject$$cancelRefundDate": "String",
        "ResultObject$$reason": "String",
        "ResultObject$$requestDate": "String",
        "ResultObject$$orderDate": "String",
        "ResultObject$$PaymentDate": "String",
        "ResultObject$$shippingDate": "String",
        "ResultObject$$DeliveredDate": "String",
        "ResultObject$$orderNo": "Int32",
        "ResultObject$$packNo": "Int32",
        "ResultObject$$itemCode": "String",
        "ResultObject$$sellerItemCode": "String",
        "ResultObject$$itemTitle": "String",
        "ResultObject$$orderQty": "Int32",
        "ResultObject$$paymentNation": "String",
        "ResultObject$$currency": "String",
        "ResultObject$$paymentAmount": "Decimal",
        "ResultObject$$deliveryCompany": "String",
        "ResultObject$$trackingNo": "String",
        "ResultObject$$deliveryCompanyReturn": "String",
        "ResultObject$$trackingNoReturn": "String",
        "ResultObject$$pickupAddress": "String",
        "ResultObject$$zipCode": "String",
        "ResultObject$$paymentReturnShipping": "String",
        "ResultObject$$itemCondition": "String",
        "ResultObject$$receiver": "String",
        "ResultObject$$receiverTel": "String",
        "ResultObject$$receiverMobile": "String",
        "ResultObject$$buyer": "String",
        "ResultObject$$buyerTel": "String",
        "ResultObject$$buyerMobile": "String",
        "ResultObject$$CODCancelPrice": "Decimal",
        "ResultObject$$CODQrefundPrice": "Decimal",
        "ResultObject$$CODCancelRelatedOrder": "String",
        "ResultObject$$nrDutyTarget": "String",
        "ResultObject$$nrSolType": "String",
        "ResultObject$$nrPartRefundCnt": "Int32",
        "ResultObject$$nrPartRefundBalance": "Decimal"
      },
      "xml": false
    },
    "ShippingBasic.GetSellingReportDeliveryFeeDetailList": {
      "id": 15096,
      "version": "1.0",
      "risk": "R",
      "description": "Get Selling Report Delivery Fee Detail List",
      "input_schema": {
        "type": "object",
        "properties": {
          "SearchCondition": {
            "type": "string",
            "description": "Search Condition\n1: Buyer's payment date\n2: Ship Date\nOfficial example: 1",
            "maxLength": 1,
            "minLength": 1,
            "enum": [
              "1",
              "2",
              "3",
              "4"
            ]
          },
          "Search_Sdate": {
            "type": "string",
            "description": "Search Start date\n2019-01-01 (yyyy-MM-dd), 2019-01-01 15:30:00 (yyyy-MM-dd HH:mm:ss)\nOfficial example: 2019-01-01",
            "maxLength": 262144,
            "minLength": 1
          },
          "Search_Edate": {
            "type": "string",
            "description": "Search End date\n2019-01-01 (yyyy-MM-dd), 2019-01-01 15:30:00 (yyyy-MM-dd HH:mm:ss)\nOfficial example: 2019-01-01",
            "maxLength": 262144,
            "minLength": 1
          },
          "CartNo": {
            "type": "string",
            "description": "Cart No\nOfficial example: 110000000",
            "maxLength": 50
          },
          "Currency": {
            "type": "string",
            "description": "JPY\nOfficial example: JPY",
            "maxLength": 3,
            "minLength": 1,
            "enum": [
              "JPY"
            ]
          }
        },
        "required": [
          "SearchCondition",
          "Search_Sdate",
          "Search_Edate",
          "Currency"
        ],
        "additionalProperties": false,
        "description": "Get Selling Report Delivery Fee Detail List\nOfficial QAPI method 15096; version 1.0.\n배송비내역 조회"
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "xml",
      "output_types": {
        "XmlDocument": "XmlDocument"
      },
      "xml": true
    },
    "ShippingBasic.GetSellingReportDetailList": {
      "id": 15095,
      "version": "1.0",
      "risk": "R",
      "description": "Get Selling Report Detail List",
      "input_schema": {
        "type": "object",
        "properties": {
          "SearchCondition": {
            "type": "string",
            "description": "Search Condition\nOfficial example: 1",
            "maxLength": 1,
            "minLength": 1,
            "enum": [
              "1",
              "2",
              "3",
              "4"
            ]
          },
          "Search_Sdate": {
            "type": "string",
            "description": "Search Start date\n2019-01-01 (yyyy-MM-dd), 2019-01-01 15:30:00 (yyyy-MM-dd HH:mm:ss)\nOfficial example: 2019-01-01",
            "maxLength": 262144,
            "minLength": 1
          },
          "Search_Edate": {
            "type": "string",
            "description": "Search End date\n2019-01-01 (yyyy-MM-dd), 2019-01-01 15:30:00 (yyyy-MM-dd HH:mm:ss)\nOfficial example: 2019-01-01 ",
            "maxLength": 262144,
            "minLength": 1
          },
          "CartNo": {
            "type": "string",
            "description": "Cart No\nOfficial example: 110000000",
            "maxLength": 50
          },
          "Currency": {
            "type": "string",
            "description": "JPY\nOfficial example: JPY",
            "maxLength": 3,
            "minLength": 1,
            "enum": [
              "JPY"
            ]
          }
        },
        "required": [
          "SearchCondition",
          "Search_Sdate",
          "Search_Edate",
          "Currency"
        ],
        "additionalProperties": false,
        "description": "Get Selling Report Detail List\nOfficial QAPI method 15095; version 1.0.\n판매내역 조회"
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "xml",
      "output_types": {
        "XmlDocument": "XmlDocument"
      },
      "xml": true
    },
    "ShippingBasic.GetSellingReportDiscountFeeDetailList": {
      "id": 15097,
      "version": "1.0",
      "risk": "R",
      "description": "Get Selling Report Discount Fee Detail List",
      "input_schema": {
        "type": "object",
        "properties": {
          "SearchCondition": {
            "type": "string",
            "description": "Search Condition\nOfficial example: 1",
            "maxLength": 1,
            "minLength": 1,
            "enum": [
              "1",
              "2",
              "3",
              "4"
            ]
          },
          "Search_Sdate": {
            "type": "string",
            "description": "Search Start date\n2019-01-01 (yyyy-MM-dd), 2019-01-01 15:30:00 (yyyy-MM-dd HH:mm:ss)\nOfficial example: 2019-01-01",
            "maxLength": 262144,
            "minLength": 1
          },
          "Search_Edate": {
            "type": "string",
            "description": "Search End date\n2019-01-01 (yyyy-MM-dd), 2019-01-01 15:30:00 (yyyy-MM-dd HH:mm:ss)\nOfficial example: 2019-01-01",
            "maxLength": 262144,
            "minLength": 1
          },
          "CartNo": {
            "type": "string",
            "description": "Cart No\nOfficial example: 110000000",
            "maxLength": 50
          },
          "Currency": {
            "type": "string",
            "description": "JPY\nOfficial example: JPY",
            "maxLength": 3,
            "minLength": 1,
            "enum": [
              "JPY"
            ]
          }
        },
        "required": [
          "SearchCondition",
          "Search_Sdate",
          "Search_Edate",
          "Currency"
        ],
        "additionalProperties": false,
        "description": "Get Selling Report Discount Fee Detail List\nOfficial QAPI method 15097; version 1.0.\n장바구니할인내역 조회"
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "xml",
      "output_types": {
        "XmlDocument": "XmlDocument"
      },
      "xml": true
    },
    "CSCenter.GetInquiryMessage": {
      "id": 10055,
      "version": "1.0",
      "risk": "R",
      "description": "Get Inquiry Message",
      "input_schema": {
        "type": "object",
        "properties": {
          "search_start_dt": {
            "type": "string",
            "description": "start date to search\n20190101 (yyyyMMdd), 20190101153000 (yyyyMMddHHmmss)\nOfficial example: 20190101",
            "maxLength": 14,
            "minLength": 1,
            "pattern": "^[0-9]{8}([0-9]{6})?$"
          },
          "search_end_dt": {
            "type": "string",
            "description": "end date to search\n20190101 (yyyyMMdd), 20190101153000 (yyyyMMddHHmmss)\nOfficial example: 20190101",
            "maxLength": 14,
            "minLength": 1,
            "pattern": "^[0-9]{8}([0-9]{6})?$"
          },
          "proc_status": {
            "type": "string",
            "description": "Processing status (S1, S2, S3)\nS1: unanswered\nS2: Processing\nS3: Completed\nOfficial example: S1",
            "maxLength": 2,
            "enum": [
              "S1",
              "S2",
              "S3"
            ]
          }
        },
        "required": [
          "search_start_dt",
          "search_end_dt"
        ],
        "additionalProperties": false,
        "description": "Get Inquiry Message\nOfficial QAPI method 10055; version 1.0.\n판매자 문의를 조회하기 위한 Method 입니다. "
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [
        "search_start_dt",
        "search_end_dt"
      ],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$INQ_TYPE": "String",
        "ResultObject$$SEQ_NO": "Int32",
        "ResultObject$$QUESTION_NO": "Int32",
        "ResultObject$$INQ_DT": "String",
        "ResultObject$$CUST_NM": "String",
        "ResultObject$$CATE_NM": "String",
        "ResultObject$$CATE_CD": "String",
        "ResultObject$$TITLE": "String",
        "ResultObject$$CONTENTS": "String",
        "ResultObject$$GD_NO": "String",
        "ResultObject$$GD_NM": "String",
        "ResultObject$$CONTR_NO": "Int32",
        "ResultObject$$CLAIM_YN": "String",
        "ResultObject$$STATUS": "String"
      },
      "xml": false
    },
    "CSCenter.SetInquiryMessage": {
      "id": 10056,
      "version": "1.0",
      "risk": "H",
      "description": "Reply to a customer inquiry",
      "input_schema": {
        "type": "object",
        "properties": {
          "inq_type": {
            "type": "string",
            "description": "Inquiry Type (MSG, HELP, ITEM)\nOfficial example: MSG",
            "maxLength": 4,
            "minLength": 1,
            "enum": [
              "MSG",
              "HELP",
              "ITEM"
            ]
          },
          "question_no": {
            "type": "string",
            "description": "Question number\nOfficial example: 12345678",
            "maxLength": 262144,
            "minLength": 1
          },
          "seq_no": {
            "type": "string",
            "description": "Inquiry sequence number\nOfficial example: 12345678",
            "maxLength": 262144,
            "minLength": 1
          },
          "contents": {
            "type": "string",
            "description": "Contents of reply\nOfficial example: お問い合わせいただきありがとうございます。",
            "maxLength": 4000
          }
        },
        "required": [
          "inq_type",
          "question_no",
          "seq_no"
        ],
        "additionalProperties": false,
        "description": "Reply to a customer inquiry\nOfficial QAPI method 10056; version 1.0.\n문의를 처리하기 위한 Method 입니다. "
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "object",
      "output_types": {
        "ResultObject$$SEQ_NO": "Int32"
      },
      "xml": false
    },
    "Claim.SetCancelProcess": {
      "id": 10059,
      "version": "1.0",
      "risk": "D",
      "description": "Cancel an order",
      "input_schema": {
        "type": "object",
        "properties": {
          "ContrNo": {
            "type": "string",
            "description": "Order number\nOfficial example: 110000000",
            "maxLength": 262144,
            "minLength": 1
          },
          "CancelReason": {
            "type": "string",
            "description": "Reason of cancellation<br/>\nNull: Out of Stock<br/>\n1: Edit Order<br/>\n2: undeliverable region<br/>\n3: Shipping Delay\nOfficial example: 3",
            "maxLength": 1,
            "enum": [
              "",
              "1",
              "2",
              "3"
            ]
          },
          "SellerMemo": {
            "type": "string",
            "description": "Memo to buyer\nOfficial example: 不在の場合は管理室に預けてください。",
            "maxLength": 1000
          },
          "returnFeeStat": {
            "type": "string",
            "description": "Return Fee (amount that buyer should pay for return).\nOfficial example: 現在使用しない項目です",
            "maxLength": 262144
          }
        },
        "required": [
          "ContrNo"
        ],
        "additionalProperties": false,
        "description": "Cancel an order\nOfficial QAPI method 10059; version 1.0.\n 주문 번호로 취소할 수 있는 Method입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "Claim.SetClaimAccept": {
      "id": 10060,
      "version": "1.0",
      "risk": "H",
      "description": "Accept an exchange claim",
      "input_schema": {
        "type": "object",
        "properties": {
          "orderNo": {
            "type": "string",
            "description": "Order number\nOfficial example: 110066710",
            "maxLength": 262144,
            "minLength": 1
          },
          "seller_name": {
            "type": "string",
            "description": "Seller Name\nOfficial example: 例：Qoo10ショップ",
            "maxLength": 200
          },
          "seller_zip_code": {
            "type": "string",
            "description": "Seller`s Zip-code \nOfficial example: 000-0000",
            "maxLength": 10
          },
          "seller_front_address": {
            "type": "string",
            "description": "Seller`s address (State/city/town)\nOfficial example: OO県OOO市",
            "maxLength": 200
          },
          "seller_back_address": {
            "type": "string",
            "description": "Seller`s detail address\nOfficial example: ０００－００、OOOマンションOOO号室",
            "maxLength": 200
          },
          "seller_hp_no": {
            "type": "string",
            "description": "Seller`s Mobile number\nOfficial example: 090‐0000-0000",
            "maxLength": 200
          },
          "seller_tel_no": {
            "type": "string",
            "description": "Seller`s Phone number\nOfficial example: 0000-00-0000",
            "maxLength": 200
          }
        },
        "required": [
          "orderNo"
        ],
        "additionalProperties": false,
        "description": "Accept an exchange claim\nOfficial QAPI method 10060; version 1.0.\n판매자가 교환을 승인하는 Method입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "Claim.SetClaimRedelivery": {
      "id": 10061,
      "version": "1.0",
      "risk": "H",
      "description": "Register an exchange redelivery",
      "input_schema": {
        "type": "object",
        "properties": {
          "orderNo": {
            "type": "string",
            "description": "주문번호\nOfficial example: 123456789",
            "maxLength": 262144,
            "minLength": 1
          },
          "redelivery_date": {
            "type": "string",
            "description": "재 발송일<br>2019-01-01 (yyyy-MM-dd), 2019-01-01 15:30:00 (yyyy-MM-dd HH:mm:ss)\nOfficial example: 2019-01-01",
            "maxLength": 262144,
            "minLength": 1
          },
          "invoice_no": {
            "type": "string",
            "description": "송장번호\nOfficial example: 1234567890AA",
            "maxLength": 50
          },
          "del_comapny_name": {
            "type": "string",
            "description": "택배사\nOfficial example: 佐川急便",
            "maxLength": 200
          },
          "rcv_name": {
            "type": "string",
            "description": "수취인명\nOfficial example: 山田太郎",
            "maxLength": 200
          },
          "rcv_zip_code": {
            "type": "string",
            "description": "수취인주소 우편번호\nOfficial example: 123-1234",
            "maxLength": 10
          },
          "rcv_front_address": {
            "type": "string",
            "description": "앞단 수취인 주소(State/City)\nOfficial example: OO県OOO市",
            "maxLength": 200
          },
          "rcv_back_address": {
            "type": "string",
            "description": "뒷단 수취인주소(시구정촌 이후)\nOfficial example: OOO‐OO、OOOOマンションOO号室",
            "maxLength": 200
          },
          "rcv_hp_no": {
            "type": "string",
            "description": "수취인 휴대폰번호\nOfficial example: 090-0000-0000",
            "maxLength": 20
          },
          "rcv_tel_no": {
            "type": "string",
            "description": "수취안 전호번호\nOfficial example: 1234-56-7890",
            "maxLength": 20
          }
        },
        "required": [
          "orderNo",
          "redelivery_date"
        ],
        "additionalProperties": false,
        "description": "Register an exchange redelivery\nOfficial QAPI method 10061; version 1.0.\n교환상품을 재배송하는 Method입니다."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "envelope",
      "output_types": {
        "ResultCode": "Int32",
        "ResultMsg": "String"
      },
      "xml": false
    },
    "CommonInfoLookup.GetCatagoryListAll": {
      "id": 10037,
      "version": "1.0",
      "risk": "R",
      "description": "Get Catagory List All",
      "input_schema": {
        "type": "object",
        "properties": {
          "lang_cd": {
            "type": "string",
            "description": "Language code\n일본어: JA\n한국어: KO\n영어: EN\n중국어: ZH-CN\nOfficial example: JA",
            "maxLength": 5,
            "enum": [
              "JA",
              "KO",
              "EN",
              "ZH-CN"
            ]
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Get Catagory List All\nOfficial QAPI method 10037; version 1.0.\n모든 카테고리를 조회하기 위한 Method 입니다. "
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$CATE_L_CD": "String",
        "ResultObject$$CATE_L_NM": "String",
        "ResultObject$$CATE_M_CD": "String",
        "ResultObject$$CATE_M_NM": "String",
        "ResultObject$$CATE_S_CD": "String",
        "ResultObject$$CATE_S_NM": "String"
      },
      "xml": false
    },
    "CommonInfoLookup.SearchMaker": {
      "id": 10038,
      "version": "1.0",
      "risk": "R",
      "description": "Search Maker",
      "input_schema": {
        "type": "object",
        "properties": {
          "keyword": {
            "type": "string",
            "description": "search keyword",
            "maxLength": 50
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Search Maker\nOfficial QAPI method 10038; version 1.0.\n제조사를 검색하기위한 Method 입니다. "
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$M_B_NO": "String",
        "ResultObject$$M_B_NM": "String",
        "ResultObject$$M_B_NM_EN": "String"
      },
      "xml": false
    },
    "CommonInfoLookup.SearchBrand": {
      "id": 10039,
      "version": "1.0",
      "risk": "R",
      "description": "Search Brand",
      "input_schema": {
        "type": "object",
        "properties": {
          "keyword": {
            "type": "string",
            "description": "Search keyword\nOfficial example: Nike",
            "maxLength": 50,
            "minLength": 1
          }
        },
        "required": [
          "keyword"
        ],
        "additionalProperties": false,
        "description": "Search Brand\nOfficial QAPI method 10039; version 1.0.\n브랜드를 검색하기 위한 Method 입니다. "
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [],
      "output_kind": "array",
      "output_types": {
        "ResultObject$$M_B_NO": "String",
        "ResultObject$$M_B_NM": "String",
        "ResultObject$$M_B_NM_EN": "String"
      },
      "xml": false
    },
    "ShippingBasic.GetShippingInfo_Logistics": {
      "id": 15776,
      "version": "1.0",
      "risk": "R",
      "description": "Get Shipping Info_Logistics",
      "input_schema": {
        "type": "object",
        "properties": {
          "ShippingStatus": {
            "type": "string",
            "description": "Shipping Status Code 1: Delivery Preparation 2: Delivery Requested 3:  Delivery Confirmed 4: On delivery 5: Delivery complete <br> *0 or blank: 1&2",
            "maxLength": 1,
            "enum": [
              "0",
              "1",
              "2",
              "3",
              "4",
              "5"
            ]
          },
          "SearchStartDate": {
            "type": "string",
            "description": "Start date to search dispatch<br>20230101(yyyyMMdd), 20230101153000(yyyyMMddHHmmss)",
            "maxLength": 14,
            "pattern": "^[0-9]{8}([0-9]{6})?$"
          },
          "SearchEndDate": {
            "type": "string",
            "description": "End date to search dispatch<br>20230101(yyyyMMdd), 20230101153000(yyyyMMddHHmmss)",
            "maxLength": 14,
            "pattern": "^[0-9]{8}([0-9]{6})?$"
          },
          "SearchCondition": {
            "type": "string",
            "description": "Search condition(1：Order Date、2：Payment Date、3：Delivery start Date、4：Delivered Date) ",
            "maxLength": 1,
            "enum": [
              "1",
              "2",
              "3",
              "4"
            ]
          },
          "ReceiverInfoEditYN": {
            "type": "string",
            "description": "Recipient, contact information, address modification status (Y: modification history, N: no modification history)",
            "maxLength": 1,
            "enum": [
              "Y",
              "N"
            ]
          }
        },
        "required": [],
        "additionalProperties": false,
        "description": "Get Shipping Info_Logistics\nOfficial QAPI method 15776; version 1.0.\n이 Method는 한국 물류사 전용입니다. 일반 판매자에게는 불필요한 정보가 추가될 예정이니 판매자 배송상태 정보를 조회하려면 배송/취소/미수취&gt;&gt;배송취소정보조회&gt;&gt;ShippingBasic.GetShippingInfo_v3를 이용해주세요."
      },
      "batch": null,
      "row_fields": [],
      "date_fields": [
        "SearchStartDate",
        "SearchEndDate"
      ],
      "output_kind": "envelope",
      "output_types": {
        "ResultObject$$ShippingStatus": "String",
        "ResultObject$$SellerID": "String",
        "ResultObject$$PackNo": "Int32",
        "ResultObject$$OrderDate": "String",
        "ResultObject$$PaymentDate": "String",
        "ResultObject$$EstimatedShippingDate": "String",
        "ResultObject$$ShippingDate": "String",
        "ResultObject$$DeliveredDate": "String",
        "ResultObject$$Buyer": "String",
        "ResultObject$$BuyerKana": "String",
        "ResultObject$$BuyerTel": "String",
        "ResultObject$$BuyerMobile": "String",
        "ResultObject$$BuyerEmail": "String",
        "ResultObject$$OrderNo": "Int32",
        "ResultObject$$ItemNo": "String",
        "ResultObject$$SellerItemCode": "String",
        "ResultObject$$ItemTitle": "String",
        "ResultObject$$Option": "String",
        "ResultObject$$OptionCode": "String",
        "ResultObject$$OrderPrice": "Decimal",
        "ResultObject$$OrderQty": "Int32",
        "ResultObject$$Discount": "Decimal",
        "ResultObject$$Total": "Decimal",
        "ResultObject$$Receiver": "String",
        "ResultObject$$ReceiverKana": "String",
        "ResultObject$$ZipCode": "String",
        "ResultObject$$ShippingAddress": "String",
        "ResultObject$$Address1": "String",
        "ResultObject$$Address2": "String",
        "ResultObject$$ReceiverTel": "String",
        "ResultObject$$ReceiverMobile": "String",
        "ResultObject$$DesiredDeliveryDate": "String",
        "ResultObject$$SenderName": "String",
        "ResultObject$$SenderTel": "String",
        "ResultObject$$SenderNation": "String",
        "ResultObject$$SenderZipCode": "String",
        "ResultObject$$SenderAddress": "String",
        "ResultObject$$ShippingWay": "String",
        "ResultObject$$ShippingMessage": "String",
        "ResultObject$$PaymentMethod": "String",
        "ResultObject$$SellerDiscount": "Decimal",
        "ResultObject$$Currency": "String",
        "ResultObject$$ShippingRate": "Decimal",
        "ResultObject$$RelatedOrder": "String",
        "ResultObject$$ShippingRateType": "String",
        "ResultObject$$DeliveryCompany": "String",
        "ResultObject$$VoucherCode": "String",
        "ResultObject$$PackingNo": "String",
        "ResultObject$$SellerDeliveryNo": "String",
        "ResultObject$$Gift": "String",
        "ResultObject$$CartDiscountSeller": "Decimal",
        "ResultObject$$CartDiscountQoo10": "Decimal",
        "ResultObject$$SettlePrice": "Decimal",
        "ResultObject$$BranchName": "String",
        "ResultObject$$TrackingNo": "String",
        "ResultObject$$Material": "String",
        "ResultObject$$AvailableSendType": "String",
        "ResultObject$$AvailableShippingDate": "String"
      },
      "xml": false
    }
  },
  "exclusions": [
    {
      "action": "CertificationAPI.CreateCertificationKey",
      "category": "credential_issuance",
      "reason": "Requires API ID plus seller login user_id/password; existing Certification Key identity is retained."
    }
  ]
};
