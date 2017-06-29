'use strict';

const apiai = require('apiai');
const express = require('express');
const bodyParser = require('body-parser');
const uuid = require('uuid');
const request = require('request');
const JSONbig = require('json-bigint');
const async = require('async');
const mongodb = require('mongodb'); // them module ket noi db


const REST_PORT = (process.env.PORT || 5000);
const APIAI_ACCESS_TOKEN = process.env.APIAI_ACCESS_TOKEN;
const APIAI_LANG = process.env.APIAI_LANG || 'en';
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const FB_TEXT_LIMIT = 640;
const MONGOHQ_URL = process.env.MONGOHQ_URL;

const FACEBOOK_LOCATION = "FACEBOOK_LOCATION";
const FACEBOOK_WELCOME = "FACEBOOK_WELCOME";

class FacebookBot {

    constructor() {
        this.apiAiService = apiai(APIAI_ACCESS_TOKEN, {language: APIAI_LANG, requestSource: "fb"});
        this.sessionIds = new Map();
        this.messagesDelay = 200;
        this.userInfo = null;
    }


    doDataResponse(sender, facebookResponseData) {
        if (!Array.isArray(facebookResponseData)) {
            console.log('Response as formatted message');
            this.sendFBMessage(sender, facebookResponseData)
                .catch(err => console.error(err));
        } else {
            async.eachSeries(facebookResponseData, (facebookMessage, callback) => {
                if (facebookMessage.sender_action) {
                    console.log('Response as sender action');
                    this.sendFBSenderAction(sender, facebookMessage.sender_action)
                        .then(() => callback())
                        .catch(err => callback(err));
                }
                else {
                    console.log('Response as formatted message');
                    this.sendFBMessage(sender, facebookMessage)
                        .then(() => callback())
                        .catch(err => callback(err));
                }
            }, (err) => {
                if (err) {
                    console.error(err);
                } else {
                    console.log('Data response completed');
                }
            });
        }
    }

    doRichContentResponse(sender, messages) {
        console.log(JSON.stringify(messages));

        let facebookMessages = []; // array with result messages

        for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
            let message = messages[messageIndex];

            switch (message.type) {
                //message.type 0 means text message
                case 0:
                    // speech: ["hi"]
                    // we have to get value from fulfillment.speech, because of here is raw speech
                    if (message.speech) {

                        let splittedText = this.splitResponse(message.speech);

                        splittedText.forEach(s => {
                            facebookMessages.push({text: s});
                        });
                    }

                    break;
                //message.type 1 means card message
                case 1: {
                    let carousel = [message];

                    for (messageIndex++; messageIndex < messages.length; messageIndex++) {
                        if (messages[messageIndex].type == 1) {
                            carousel.push(messages[messageIndex]);
                        } else {
                            messageIndex--;
                            break;
                        }
                    }

                    let facebookMessage = {};
                    carousel.forEach((c) => {
                        // buttons: [ {text: "hi", postback: "postback"} ], imageUrl: "", title: "", subtitle: ""

                        let card = {};

                        card.title = c.title;
                        card.image_url = c.imageUrl;
                        if (this.isDefined(c.subtitle)) {
                            card.subtitle = c.subtitle;
                        }
                        //If button is involved in.
                        if (c.buttons.length > 0) {
                            let buttons = [];
                            for (let buttonIndex = 0; buttonIndex < c.buttons.length; buttonIndex++) {
                                let button = c.buttons[buttonIndex];

                                if (button.text) {
                                    let postback = button.postback;
                                    if (!postback) {
                                        postback = button.text;
                                    }

                                    let buttonDescription = {
                                        title: button.text
                                    };

                                    if (postback.startsWith("http")) {
                                        buttonDescription.type = "web_url";
                                        buttonDescription.url = postback;
                                    } else {
                                        buttonDescription.type = "postback";
                                        buttonDescription.payload = postback;
                                    }

                                    buttons.push(buttonDescription);
                                }
                            }

                            if (buttons.length > 0) {
                                card.buttons = buttons;
                            }
                        }

                        if (!facebookMessage.attachment) {
                            facebookMessage.attachment = {type: "template"};
                        }

                        if (!facebookMessage.attachment.payload) {
                            facebookMessage.attachment.payload = {template_type: "generic", elements: []};
                        }

                        facebookMessage.attachment.payload.elements.push(card);
                    });

                    facebookMessages.push(facebookMessage);
                }

                    break;
                //message.type 2 means quick replies message
                case 2: {
                    if (message.replies && message.replies.length > 0) {
                        let facebookMessage = {};

                        facebookMessage.text = message.title ? message.title : 'Choose an item';
                        facebookMessage.quick_replies = [];

                        message.replies.forEach((r) => {
                            facebookMessage.quick_replies.push({
                                content_type: "text",
                                title: r,
                                payload: r
                            });
                        });

                        facebookMessages.push(facebookMessage);
                    }
                }

                    break;
                //message.type 3 means image message
                case 3:

                    if (message.imageUrl) {
                        let facebookMessage = {};

                        // "imageUrl": "http://example.com/image.jpg"
                        facebookMessage.attachment = {type: "image"};
                        facebookMessage.attachment.payload = {url: message.imageUrl};

                        facebookMessages.push(facebookMessage);
                    }

                    break;
                //message.type 4 means custom payload message
                case 4:
                    if (message.payload && message.payload.facebook) {
                        facebookMessages.push(message.payload.facebook);
                    }
                    break;

                default:
                    break;
            }
        }

        return new Promise((resolve, reject) => {
            async.eachSeries(facebookMessages, (msg, callback) => {
                    this.sendFBSenderAction(sender, "typing_on")
                        .then(() => this.sleep(this.messagesDelay))
                        .then(() => this.sendFBMessage(sender, msg))
                        .then(() => callback())
                        .catch(callback);
                },
                (err) => {
                    if (err) {
                        console.error(err);
                        reject(err);
                    } else {
                       //console.log('Messages sent');
                        resolve();
                    }
                });
        });

    }

    doTextResponse(sender, responseText) {
        console.log('Response as text message');
        // facebook API limit for text length is 640,
        // so we must split message if needed
        let splittedText = this.splitResponse(responseText);

        async.eachSeries(splittedText, (textPart, callback) => {
            this.sendFBMessage(sender, {text: textPart})
                .then(() => callback())
                .catch(err => callback(err));
        });
    }

    //which webhook event
    getEventText(event) {
        if (event.message) {
            if (event.message.quick_reply && event.message.quick_reply.payload) {
                return event.message.quick_reply.payload;
            }

            if (event.message.text) {
                return event.message.text;
            }
        }

        if (event.postback && event.postback.payload) {
            return event.postback.payload;
        }

        return null;

    }

    getFacebookEvent(event) {
        if (event.postback && event.postback.payload) {

            let payload = event.postback.payload;

            switch (payload) {
                case FACEBOOK_WELCOME:
                    return {name: FACEBOOK_WELCOME};

                case FACEBOOK_LOCATION:
                    return {name: FACEBOOK_LOCATION, data: event.postback.data};
            }
        }

        return null;
    }

    processFacebookEvent(event) {
        const sender = event.sender.id.toString();
        const eventObject = this.getFacebookEvent(event);

        if (eventObject) {

            // Handle a text message from this sender
            if (!this.sessionIds.has(sender)) {
                this.sessionIds.set(sender, uuid.v4());
            }

            let apiaiRequest = this.apiAiService.eventRequest(eventObject,
                {
                    sessionId: this.sessionIds.get(sender),
                    originalRequest: {
                        data: event,
                        source: "facebook"
                    }
                });
            this.doApiAiRequest(apiaiRequest, sender);
        }
    }

    processMessageEvent(event) {
        const sender = event.sender.id.toString();
        const text = this.getEventText(event);

        if (text) {

            // Handle a text message from this sender
            if (!this.sessionIds.has(sender)) {
                this.sessionIds.set(sender, uuid.v4());
            }

            //console.log("Text", text);
            //send user's text to api.ai service
            let apiaiRequest = this.apiAiService.textRequest(text,
                {
                    sessionId: this.sessionIds.get(sender),
                    originalRequest: {
                        data: event,
                        source: "facebook"
                    }
                });

            this.doApiAiRequest(apiaiRequest, sender);
        }
    }

    doApiAiRequest(apiaiRequest, sender) {
        apiaiRequest.on('response', (response) => {
            if (this.isDefined(response.result) && this.isDefined(response.result.fulfillment)) {
                let responseText = response.result.fulfillment.speech;
                let responseData = response.result.fulfillment.data;
                let responseMessages = response.result.fulfillment.messages;

                if (this.isDefined(responseData) && this.isDefined(responseData.facebook)) {
                    let facebookResponseData = responseData.facebook;
                    this.doDataResponse(sender, facebookResponseData);
                } else if (this.isDefined(responseMessages) && responseMessages.length > 0) {
                    this.doRichContentResponse(sender, responseMessages);
                }
                else if (this.isDefined(responseText)) {
                    this.doTextResponse(sender, responseText);
                }

            }
        });

        apiaiRequest.on('error', (error) => console.error(error));
        apiaiRequest.end();
    }

    splitResponse(str) {
        if (str.length <= FB_TEXT_LIMIT) {
            return [str];
        }

        return this.chunkString(str, FB_TEXT_LIMIT);
    }

    chunkString(s, len) {
        let curr = len, prev = 0;

        let output = [];

        while (s[curr]) {
            if (s[curr++] == ' ') {
                output.push(s.substring(prev, curr));
                prev = curr;
                curr += len;
            }
            else {
                let currReverse = curr;
                do {
                    if (s.substring(currReverse - 1, currReverse) == ' ') {
                        output.push(s.substring(prev, currReverse));
                        prev = currReverse;
                        curr = currReverse + len;
                        break;
                    }
                    currReverse--;
                } while (currReverse > prev)
            }
        }
        output.push(s.substr(prev));
        return output;
    }

    sendFBMultiMessage(sender, messArray) {

         return new Promise((resolve, reject) => {
            async.eachSeries(messArray, (msg, callback) => {
                    this.sendFBSenderAction(sender, "typing_on")
                        .then(() => this.sleep(this.messagesDelay))
                        .then(() => this.sendFBMessage(sender, msg))
                        .then(() => callback())
                        .catch(callback);
                },
                (err) => {
                    if (err) {
                        console.error(err);
                        reject(err);
                    } else {
                       //console.log('Messages sent');
                        resolve();
                    }
                });
        });
    }

    sendFBMessage(sender, messageData) {
        console.log(JSON.stringify(messageData));
        //  chuyển full name thành tên người dùng.
        if( messageData.text && (messageData.text.includes("[full_name]")) ){
            messageData.text =  messageData.text.replace("[full_name]", this.userInfo.last_name + " " + this.userInfo.first_name);
        }

        return new Promise((resolve, reject) => {
            request({
                url: 'https://graph.facebook.com/v2.6/me/messages',
                qs: {access_token: FB_PAGE_ACCESS_TOKEN},
                method: 'POST',
                json: {
                    recipient: {id: sender},
                    message: messageData
                }
            }, (error, response) => {
                if (error) {
                    console.log('Error sending message: ', error);
                    reject(error);
                } else if (response.body.error) {
                    console.log(JSON.stringify(messageData));
                    console.log('Send : ', response.body.error);
                    reject(new Error(response.body.error));
                }

                resolve();
            });
        });
    }

    sendFBSenderAction(sender, action) {
        return new Promise((resolve, reject) => {
            request({
                url: 'https://graph.facebook.com/v2.6/me/messages',
                qs: {access_token: FB_PAGE_ACCESS_TOKEN},
                method: 'POST',
                json: {
                    recipient: {id: sender},
                    sender_action: action
                }
            }, (error, response) => {
                if (error) {
                    console.error('Error sending action: ', error);
                    reject(error);
                } else if (response.body.error) {
                    console.error('Error sendFBSenderAction: ', response.body.error);
                    reject(new Error(response.body.error));
                }

                resolve();
            });
        });
    }

    doSubscribeRequest() {
        request({
                method: 'POST',
                uri: `https://graph.facebook.com/v2.6/me/subscribed_apps?access_token=${FB_PAGE_ACCESS_TOKEN}`
            },
            (error, response, body) => {
                if (error) {
                    console.error('Error while subscription: ', error);
                } else {
                    console.log('Subscription result: ', response.body);
                }
            });
    }

    configureGetStartedEvent() {
        request({
                method: 'POST',
                uri: `https://graph.facebook.com/v2.6/me/thread_settings?access_token=${FB_PAGE_ACCESS_TOKEN}`,
                json: {
                    setting_type: "call_to_actions",
                    thread_state: "new_thread",
                    call_to_actions: [
                        {
                            payload: FACEBOOK_WELCOME
                        }
                    ]
                }
            },
            (error, response, body) => {
                if (error) {
                    console.error('Error while subscription', error);
                } else {
                    console.log('Subscription result', response.body);
                }
            });
    }

    isDefined(obj) {
        if (typeof obj == 'undefined') {
            return false;
        }

        if (!obj) {
            return false;
        }

        return obj != null;
    }

    sleep(delay) {
        return new Promise((resolve, reject) => {
            setTimeout(() => resolve(), delay);
        });
    }

    saveUserInfo(sender)
    {
         request({
                method: 'GET',
                uri: `https://graph.facebook.com/v2.6/${sender}/?access_token=${FB_PAGE_ACCESS_TOKEN}`,
                
            },
            (error, response, body) => {
                if (error) {
                    console.error('Error while get sender id info', error);
                } else {
                    const data = JSONbig.parse(response.body);
                    data.sender = sender;
                    console.log("hasupload");
                    data.hasUpload = true;
                    this.updateToDb(data, "user", sender);
                }
            });
    }

    getUserFullName(sender){

        return "Võ tấn hùng";

        var MongoClient = require('mongodb').MongoClient;
        // Connect to the db
        MongoClient.connect(MONGOHQ_URL, function(err, db) {
            if(!err) {
                var collection = db.collection("user"); 
    
                collection.findOne({sender: sender}, function(err, document) {
                  var full_name = document.first_name + " " + document.last_name;
                  console.log(full_name);
                  db.close();
                  return full_name;
                });

                db.close();
                return "Bạn";
                
            }
            else {
                console.log(err);
                return "Bạn";
            }
        });
                
    }

    // Lưu dữ liẹu vào db
    saveToDb(data, collection_name)
    {
        var MongoClient = require('mongodb').MongoClient;

        // Connect to the db
        MongoClient.connect(MONGOHQ_URL, function(err, db) {
            if(!err) {
                var collection = db.collection(collection_name);
                //Create some document
              
                // Insert some users
                collection.insert(data, function (err, result) {
                  if (err) {
                    console.log(err);
                  } 
                  //Close connection
                  db.close();
                });
            }
            else {
                console.log(err);
            }
        });
    }


    // Lưu dữ liẹu vào db
    updateToDb(data, collection_name, sender)
    {
        var MongoClient = require('mongodb').MongoClient;

        // Connect to the db
        MongoClient.connect(MONGOHQ_URL, function(err, db) {
            if(!err) {
                var collection = db.collection(collection_name);
                //Create some document
              
                // Insert some users
                collection.update( { sender: sender }, 
                                     data, 
                                    { upsert: true }
                                );

                db.close();
            }
            else {
                console.log(err);
            }
        });
    }

	// Cac hàm xử lý dữ liệu 

	// Hien thong bao yeu cau nhap ma bau chon
	beforeVoteForUser() {
 		this.userInfo.last_message = "GET_VOTE_ID";
        var quick_reply_mess = {
           text: this.userInfo.last_name + " " + this.userInfo.first_name + " ơi, Bạn có thể bình chọn cho bài dự thi yêu thích bằng cách gửi tin nhắn có nội dung là \"Mã bài dự thi\" cho Mr. Colgate nhé."
            + "\Mã số dự thi có dạng: 123456-1 \nTrong đó 123456 là mã thí sinh; 1 là số thứ tự của bài dự thi. \nVd: 123456-1",

            quick_replies: [
              {
                "content_type": "text",
                "title": "XEM BẢNG XẾP HẠNG",
                "payload": "Bảng xếp hạng"
              },
              {
                "content_type": "text",
                "title":  "VỀ MENU CHÍNH",
                "payload": "BACK_TO_MENU"
              }                                                                         
            ]
        };

        this.sendFBMessage(this.userInfo.sender, quick_reply_mess);
        this.updateToDb(this.userInfo, "user", this.userInfo.sender); // Cap nhat 
	}
	
	// Bau chon cho thi sinh
	voteforUser(voteId){
		var text_rep = "Bạn đang bình chọn cho mã bài dự thi \"" + voteId + "\" \nĐể hoàn tất cho lt bình chọn, Hãy cung cấp thêm thông tin về bạn cho Mr. Colagte nha ;)";
        var text_mess = {
            text: text_rep
        };

        this.sendFBMessage(this.userInfo.sender, text_rep);

        if(this.userInfo.user_name && this.userInfo.phone && this.userInfo.email) {
        	this.userInfo.vote_id = voteId;
        	this.userInfo.open_gift = false;
       		var text_rep = "Chúc mừng bạn " + this.userInfo.last_name + " " + this.userInfo.first_name + " đã bình chọn thành công cho mã bài dự thi "
       		 + this.userInfo.vote_id + " \nMã bài dự thi " + this.userInfo.vote_id + " đang có " + Math.floor((Math.random() * 100) + 1)  + " điểm và đang xếp hạng thứ " + Math.floor((Math.random() * 10) + 1);
            var text_mess = {
                text: text_rep
            };	

            var quick_reply_mess= {
                text: "Mr. Colgate gửi tặng bạn 1 lượt nhận \"QUÀ MAY MẮN\" nè ^^",
                quick_replies: [
                  {
                    "content_type": "text",
                    "title": "Nhận quà",
                    "payload": "SHOW_GIFT"
                  },
                  {
                    "content_type": "text",
                    "title": "Bỏ qua",
                    "payload": "BACK_TO_MENU"
                  }
                ]
            };

            var arrayMess =[];
            arrayMess.push(text_mess);
            arrayMess.push();
            arrayMess.push(quick_reply_mess);			                                                                        
       		this.sendFBMultiMessage(this.userInfo.sender, arrayMess);

       	}
       	else { 
       		this.userInfo.flagVote = true;
       		this.userInfo.vote_id = voteId;
       		
       		var quick_reply_mess = {
                text: "Họ và tên đầy đủ của bạn là gì nè?",
                quick_replies: [
                  {
                    "content_type": "text",
                    "title":  this.userInfo.last_name + " " + this.userInfo.first_name, 
                    "payload": "USER_NAME " + this.userInfo.last_name + " " + this.userInfo.first_name
                  },
                  {
                    "content_type": "text",
                    "title":  this.userInfo.first_name + " " + this.userInfo.last_name,
                    "payload": "USER_NAME " + this.userInfo.first_name + " " + this.userInfo.last_name
                  },
                  {
                    "content_type": "text",
                    "title": "Tên khác",
                    "payload": "OTHER_NAME"
                  }
                ]
            };

            facebookBot.sendFBMessage(this.userInfo.sender, quick_reply_mess);
       	}
       
       	this.userInfo.last_message = "";
		this.updateToDb(this.userInfo, "user", this.userInfo.sender); // Cap nhat thong tin cua user;
	}

	//Hien thi 3 hop qua
	showGift(){
		var text_rep = "Mời bạn chọn 1 trong 3 hộp quà nha!";
        var text_mess = {
            text: text_rep
        };
    	var gift_mess =  {
            "attachment": {
                "type": "template",
                "payload": {
                    "template_type": "generic",
                    "elements": [{
                        "title": "Hộp quà 1",
                        "image_url": "http://i1160.photobucket.com/albums/q491/tanhung0506/cuc%20kem_zpsaaktsdfy.png",
                        "buttons": [{
                            "title": "Mở ngay",
                            "type": "postback",
                            "payload": "OPEN_GIFT_1a5a3026-dedf-4e51"
                        },{
                            "title": "Về menu chính",
                            "type": "postback",
                            "payload": "GET_STARTED_PAYLOAD"
                        }]
                    }, {
                        "title": "Hộp quà 2",
                        "image_url": "http://i1160.photobucket.com/albums/q491/tanhung0506/cuc%20kem_zpsaaktsdfy.png",
                        "buttons": [{
                            "title": "Mở ngay",
                            "type": "postback",
                            "payload": "OPEN_GIFT_1a5a3026-dedf-4e51"
                        },{
                            "title": "Về menu chính",
                            "type": "postback",
                            "payload": "GET_STARTED_PAYLOAD"
                        }]
                    }, {
                        "title": "Hộp quà 3",
                        "image_url": "http://i1160.photobucket.com/albums/q491/tanhung0506/cuc%20kem_zpsaaktsdfy.png",
                        "buttons": [{
                            "title": "Mở ngay",
                            "type": "postback",
                            "payload": "OPEN_GIFT_1a5a3026-dedf-4e51"
                        },{
                            "title": "Về menu chính",
                            "type": "postback",
                            "payload": "GET_STARTED_PAYLOAD"
                        }]
                    }]
                }
            }
        };

        var arrayMess =[];
        arrayMess.push(text_mess);                                                              
        arrayMess.push(gift_mess);			                                                                        
   		this.sendFBMultiMessage(this.userInfo.sender, arrayMess);        
	}

	// mo hop qua
	openGift(){
		if(this.userInfo.open_gift === false) {
            var rand = Math.floor((Math.random() * 10) + 1);
            if(rand >= 6) {
               var quick_reply_mess = {
                    "text": "Chúc mừng bạn đã trúng 1 \"THẺ CÀO ĐIỆN THOẠI TRỊ GIÁ 50.000 VNĐ\". \nHãy chọn nhà mạng phù hợp nào.",
                    "quick_replies": [{
                        "content_type": "text",
                        "title": "Viettel",
                        "payload": "CARD_VIETTEL"
                    }, {
                        "content_type": "text",
                        "title": "Mobiphone",
                        "payload": "CARD_MOBI"
                    }, {
                        "content_type": "text",
                        "title": "Vinaphone",
                        "payload": "CARD_VINA"
                    }]
                };
                this.sendFBMessage(this.userInfo.sender,  quick_reply_mess);                                                              
            } else {
            	var text_rep = "Buồn quá! Hộp quà của bạn không có giải thưởng rồi. Hãy \"BÌNH CHỌN\" cho Bài dự thi khác và có cơ hội nhận thêm quà nhé.";
        	 	var quick_reply_mess = {
                    "text": text_rep,
                    "quick_replies": [{
                        "content_type": "text",
                        "title": "Về menu chính",
                        "payload": "BACK_TO_MENU"
                    }]
                };


                this.sendFBMessage(this.userInfo.sender, quick_reply_mess);
            }
            this.userInfo.open_gift = true; // danh dau la da mo qua
            this.updateToDb(this.userInfo, "user", this.userInfo.sender); // Cap nhat thong tin cua user;
        }
        else {
        	var text_rep = "Bạn đã mở quà trước đó, vui lòng bầu chọn để nhận được cơ hội mở thêm quà ";
    	 	var quick_reply_mess = {
                "text": text_rep,
                "quick_replies": [{
                    "content_type": "text",
                    "title": "Về menu chính",
                    "payload": "BACK_TO_MENU"
                }]
            };

            this.sendFBMessage(this.userInfo.sender, quick_reply_mess);
        } 
	}

	//Nghe thu bai du thi cua thi sinh
	reviewUserAudioVideo(){
		var att_video  = {
              "attachment": {
              "type": "video",
              "payload": {
                "url": "https://www.dropbox.com/s/lvj5wjjteg4ybtc/Toi-Thay-Hoa-Vang-Tren-Co-Xanh-Cover-Jang-Mi.mp4?dl=1"
              }
            }
        };

        var att_info = {
            "attachment":{
              "type":"template",
              "payload":{
                "template_type":"button", 
                "text":"Mã bài dự thi 1322073801221392-1 \nThí sinh: Jang Mi  \nSố lượng bình chọn: 816\n Xếp hạng: 2",
                "buttons":[
                  {
                    "type":"web_url",
                    "url":"https://www.facebook.com/sharer.php?u=https://www.youtube.com/watch?v=wnSNyE2hVu4",
                    "title":"Share về Facebook"
                  },
                  {
                    "type":"postback",
                    "title":"Bình chọn",
                    "payload":"BC 1322073801221392"
                  },                  
	              {
	                "content_type": "text",
	                "title": "Về menu chính",
	                "payload": "BACK_TO_MENU"
	              }
                ]
              }
            }
        };

        var arrayMess =[];

        arrayMess.push(att_video);
        arrayMess.push(att_info);        
        this.sendFBMultiMessage(this.userInfo.sender, arrayMess);
	}

	confirmUpload() {
		//WEB_SERVICE 
		// Lay link luu tren website ?
		// Lay thong tin ma user, ma bai du thi.
		var sendObject = {
		    "attachment":{
		      "type":"template",
		      "payload":{
		        "template_type":"button", 
		        "text":"Chúc mừng bạn đã nộp bài thành công.\nHọ và tên: " + this.userInfo.user_name 
		        +  "\nMã thí sinh: " + this.userInfo.sender.substring(0, 6)
		        +  "\nMã bài dự thi:  " + this.userInfo.sender.substring(0, 6)  + "-" + 1,
		        "buttons":[
		          {
		            "type":"web_url",
		            "url":"https://www.facebook.com/sharer.php?u=https://www.youtube.com/watch?v=wnSNyE2hVu4",
		            "title":"Share về Facebook"
		          },                                                          
		          {
		            "type": "element_share",
		            "share_contents": { 
		              "attachment": {
		                "type": "template",
		                "payload": {
		                  "template_type": "generic",
		                  "elements": [
		                    {
		                      "title": "Tham gia thử thách maxfresh",
		                      "subtitle": "",
		                      "image_url": "https://scontent.fsgn3-1.fna.fbcdn.net/v/t31.0-8/14066477_623939167769572_7639488553815427981_o.jpg?oh=741d4d6746f95e79c3c7d5c8091608d6&oe=59CCCDF9",
		                      "default_action": {
		                        "type": "web_url",
		                        "url": "https://m.me/chatbotcolgate?ref=invited_by_chat_bot"
		                      },
		                      "buttons": [
		                        {
		                          "type": "web_url",
		                          "url": "https://m.me/chatbotcolgate?ref=invited_by_chat_bot",
		                          "title": "Tham gia"
		                        }
		                      ]
		                    }
		                  ]
		                }
		              }
		            }
		          },
		          {
		            "type":"postback",
		            "title":"Về menu chính",
		            "payload":"GET_STARTED_PAYLOAD"
		          }
		        ]
		      }
		    }
		}

		delete this.userInfo.attachment;
		this.sendFBMessage(this.userInfo.sender, sendObject);
		this.updateToDb(this.userInfo, "user", this.userInfo.sender); // Cap nhat thong tin cua user;
	}

	
	beforeConfirmUpload(file_attachment) {
		 var text_rep = this.userInfo.last_name + " " + this.userInfo.first_name + " ơi, Dưới đây là thông tin về bài dự thi của bạn. Hãy kiểm tra lại và Xác nhận bài dự thi của mình nhé.";
		                                                                    
        var text_mess = {
            text: text_rep
        };                                                                 

        var attch_mess = {
            attachment : file_attachment
        };                                                                    

        var quick_reply_mess= {
            text: "Họ tên: " + this.userInfo.user_name +  "\nSố điện thoại: " + this.userInfo.phone + "\nEmail: " + this.userInfo.email,
            quick_replies: [
              {
                "content_type": "text",
                "title": "Xác nhận",
                "payload": "CONFIRM_UPLOAD"
              },
              {
                "content_type": "text",
                "title": "Sửa thông tin",
                "payload": "EDIT_INFO"
              },
              {
                "content_type": "text",
                "title": " Huỷ bỏ",
                "payload": "CANCLE_UPLOAD"
              }
            ]
        }
        var arrayMess =[];
        arrayMess.push(text_mess);
        arrayMess.push(attch_mess);
        arrayMess.push(quick_reply_mess);

        this.sendFBMultiMessage(this.userInfo.sender, arrayMess);
	}


	fileUploadInvalid() {
		var quick_reply_mess= {
            text: "File bạn vừa gửi cho Mr. Colgate không đúng định dạng (audio/video). Hãy thử lại lần nữa nha. \nNếu đây là sai sót,"+ this.userInfo.first_name + " " + this.userInfo.last_name + " hãy thông báo cho Admin biết về sai sót này qua email: hotro@thucthachmaxfresh.vn nha.",
            quick_replies: [
              {	
                "content_type": "text",
                "title": "Cover ngay",
                "payload": "Cover ngay"
              },
              {
                "content_type": "text",
                "title": "Về menu chính",
                "payload": "BACK_TO_MENU"
              }
            ]
        }
        this.sendFBMessage(this.userInfo.sender, quick_reply_mess);
	}

	getUserInfoForUpload() {
		var text_mess_1 = {
            text: "Bạn chờ tí nhé, Mr. Colgate đang xử lý dữ liệu^^"
        };
     
    	var text_mess_2 = {
            text: "Bạn cung cấp thêm cho Mr. Colgate một vào thông tin nữa nhen :)"
        };
     
        var quick_reply_mess = {
            text: "Họ và tên đầy đủ của bạn là gì nhỉ?",
            quick_replies: [
              {
                "content_type": "text",
                "title":  this.userInfo.last_name + " " + this.userInfo.first_name, 
                "payload": "USER_NAME " + this.userInfo.last_name + " " + this.userInfo.first_name
              },
              {
                "content_type": "text",
                "title":  this.userInfo.first_name + " " + this.userInfo.last_name,
                "payload": "USER_NAME " + this.userInfo.first_name + " " + this.userInfo.last_name
              },
              {
                "content_type": "text",
                "title": "Nhập  khác",
                "payload": "OTHER_NAME"
              }
            ]
        };

        var arrayMess =[];
        arrayMess.push(text_mess_1);
        arrayMess.push(text_mess_2);
        arrayMess.push(quick_reply_mess);

        this.sendFBMultiMessage(this.userInfo.sender, arrayMess);
	}


}


let facebookBot = new FacebookBot();

const app = express();

app.use(bodyParser.text({type: 'application/json'}));

app.get('/api/', (req, res) => {

	var text_mess_2 = {
        text: "Bạn cung cấp thêm cho Mr. Colgate một vào thông tin nữa nhen :)"
    };

	request({
        method: 'GET',
        uri: `http://thuthachmaxfresh.vn/api/api-test.php`,
        json: text_mess_2
        
    },
    (error, response, body) => {
        if (error) {
            console.error('Error while get sender id info', error);
        } else {
        	console.log("response: " + JSON.stringify(response));
        	console.log("body: " + JSON.stringify(body));
        }
    });
});

app.get('/broadcast/', (req, res) => {

        var MongoClient = require('mongodb').MongoClient;

        // Connect to the db
        MongoClient.connect(MONGOHQ_URL, function(err, db) {
            if(!err) {
                var collection = db.collection("user");
                
                var listSender = collection.find({});             
                var messageData = '{"attachment":{"type":"template","payload":{"template_type":"generic","elements":[{"title":"title","image_url":"http://znews-photo-td.zadn.vn/w210/Uploaded/spcwvovd/2017_06_08/22iMac_Pro_Zing_2.JPG","subtitle":"Sub title","buttons":[{"title":"button","type":"postback","payload":"button payload"},{"title":"sub button","type":"postback","payload":"sub button payload"}]}]}}}';
                var object = {  
                    attachment:{  
                      type:"template",
                      payload:{  
                         template_type:"generic",
                         elements:[  
                            {  
                               title:"title",
                               image_url:"http://znews-photo-td.zadn.vn/w210/Uploaded/spcwvovd/2017_06_08/22iMac_Pro_Zing_2.JPG",
                               subtitle:"Sub title",
                               buttons:[  
                                  {  
                                     title:"button",
                                     type:"postback",
                                     payload:"button payload"
                                  },
                                  {  
                                     title:"sub button",
                                     type:"postback",
                                     payload:"sub button payload"
                                  }
                               ]
                            }
                         ]
                      }
                   }
                } ;

                // duyet qua list sender de gui broadcast
                listSender.forEach((mySender) => {
                    facebookBot.sendFBMessage(mySender.sender, object);
                });

                db.close();
            }
            else {
                console.log(err);
            }
        });
    res.send('Error, wrong validation token');

});

app.get('/webhook/', (req, res) => {

    if (req.query['hub.verify_token'] === FB_VERIFY_TOKEN) {
        res.send(req.query['hub.challenge']);

        setTimeout(() => {
            facebookBot.doSubscribeRequest();
        }, 3000);
    } else {
        res.send('Error, wrong validation token');
    }



});

app.post('/webhook/', (req, res) => {
    try {
        const data = JSONbig.parse(req.body);

        facebookBot.saveToDb(data, "message"); // lưu message gửi nhận
        
        if (data.entry) {
            let entries = data.entry;
            entries.forEach((entry) => {
                let messaging_events = entry.messaging;
                if (messaging_events) {
                    messaging_events.forEach((event) => {

                        // Loai tru nhung truong hop khong can phai xu ly, lay thong tin tu db
                        if(event.delivery) {
                            return true;
                        }
                        else if(event.read) {
                            return true;
                        } 
                        else if (event.message && event.message.is_echo) { 
                            if(event.message.text !==  "TURN_OFF" && event.message.text !==  "TURN_ON" ) {
                                return;
                            }
                        }

                        var sender_id = event.sender.id;
                        if (event.message && event.message.is_echo) {// neu fanpage gui cho nguoi 
                            var sender_id = event.recipient.id;
                        }




                        // Lay thong tin tu db
                        var MongoClient = require('mongodb').MongoClient;
                        MongoClient.connect(MONGOHQ_URL, function(err, db) {
                            if(!err) {
                                var collection = db.collection("user");
                                collection.findOne({sender: sender_id}, function(error, userInfo) {
                                   if(!error){
                                        if(userInfo){ // neu lay duoc thong tin nguoi dung
                                            facebookBot.userInfo = userInfo;
                                            if(event.postback &&  event.postback.payload) { // POSTBACK
                                                if(userInfo.turn_on === true) { // Cho phep chat bot tu dong hoat dong
                                                    if(event.postback.payload === "Bình chọn") {
                                                       facebookBot.beforeVoteForUser();
                                                    } 
                                                    else if (event.postback.payload.startsWith("BC ")) { // Bình chọn nhanh bang go cu phap cho thí sinh
                                                       	var voteId = event.postback.payload.replace ("BC ", "");
                                                        facebookBot.voteforUser(voteId);     
                                                    }
                                                    else if(event.postback.payload === "NGHE_THU") {
	                                                    facebookBot.reviewUserAudioVideo(); 
                                                    }
                                                    else if(event.postback.payload === "OPEN_GIFT_1a5a3026-dedf-4e51") {
                                                       	facebookBot.openGift();
                                                    }
                                                    else {
                                                    	facebookBot.processMessageEvent(event);
                                                    }  
                                                }

                                            } else if (event.message) { // MESSAGE
                                                if(!event.message.is_echo) {
                                                    if(userInfo.turn_on === true) { // Cho phep chat bot tu dong hoat dong
                                                        if (event.message.attachments) {
                                                            // FILE UPLOAD
                                                            if( event.message.attachments[0].type === "audio" || event.message.attachments[0].type === "video"){
                                                                
                                                                facebookBot.saveToDb(data, event.message.attachments[0].type); // lưu file audio tu nguoi dung

                                                                if(userInfo.user_name && userInfo.phone && userInfo.email) { // neu nguoi dung da dien thong tin truoc do
                                                                	facebookBot.beforeConfirmUpload(event.message.attachments[0]);  
                                                                } else {
                                                                	facebookBot.getUserInfoForUpload();
                                                                }   

                                                                userInfo.attachment = event.message.attachments[0]// luu lai bai du thi cuoi cung
                                                                userInfo.upload = true;
                                                                userInfo.flagVote = false;
                                                                facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user;
                                                            } 
                                                            else {
                                                            	// File upload ko dung dinh dang
                                                        	 	facebookBot.fileUploadInvalid();
                                                            }
                                                           
                                                        }// end attachments 
                                                        else if(event.message.quick_reply) { // nguoi dung nhap ten bang chon quick replay button
                                                            var payload = event.message.quick_reply.payload;
                                                            if(payload === "Bình chọn") {
                                                               facebookBot.beforeVoteForUser();       
                                                            }
                                                            else if(payload.startsWith("CONFIRM_UPLOAD")) {              
                                                                facebookBot.confirmUpload();
                                                            }
                                                            else if(payload.startsWith("CANCLE_UPLOAD")) {

                                                                delete userInfo.attachment;
                                                            
                                                                var quick_reply_mess = {
                                                                    text: ":( Mr. Colgate vừa nhận được yêu cầu huỷ bỏ bài dự thi từ bạn. " + userInfo.last_name + " " + userInfo.first_name + " có muốn COVER tiếp không?",
                                                                    quick_replies: [
                                                                      {
                                                                        "content_type": "text",
                                                                        "title":  "Cover ngay",
                                                                        "payload": "Cover ngay"
                                                                      },
                                                                      {
                                                                        "content_type": "text",
                                                                        "title":  "Về menu chính",
                                                                        "payload": "BACK_TO_MENU"
                                                                      }
                                                                    ]
                                                                };

                                                                facebookBot.sendFBMessage(event.sender.id, quick_reply_mess);

                                                            }
                                                            else if(payload.startsWith("USER_NAME")) { // Nguoi dung chon ten tren qick replay

                                                                userInfo.user_name = event.message.text;
                                                                userInfo.last_message = "GET_PHONE_NUMBER";
                                                                facebookBot.sendFBMessage(event.sender.id, '{text: "Bạn ơi cho Mr. Colgate thêm Số điện thoại nữa nha!^^"}');
                                                                facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user

                                                            } 
                                                            else if(payload.startsWith("OTHER_NAME") || payload.startsWith("EDIT_INFO")) { //nguoi dung chon ten khac

                                                                userInfo.last_message = "GET_USER_NAME";
                                                                facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user;
                                                                facebookBot.sendFBMessage(event.sender.id, '{text: "Họ và tên đầy đủ của bạn là gì nhỉ?"}');

                                                            } 
                                                            else if(payload.startsWith("CARD_VIETTEL") ||  payload.startsWith("CARD_MOBI")  || payload.startsWith("CARD_VINA") ) {
                                                                var text_resp = "Mã thẻ cào: 01592 7057 1321 \nSeri: 107612965\n10sử dụng: 12/2019";
                                                                
                                                                var quick_reply_mess = {
                                                                    text: text_resp,
                                                                    quick_replies: [
                                                                      {
                                                                        "content_type": "text",
                                                                        "title":  "Về menu chính",
                                                                        "payload": "BACK_TO_MENU"
                                                                      }
                                                                    ]
                                                                };

                                                                facebookBot.sendFBMessage(event.sender.id, quick_reply_mess);
                                                                
                                                            } 
                                                            else if(payload.startsWith("SHOW_GIFT")) {
                                                        	  	facebookBot.showGift();                                                       
                                                            } 
                                                            else if(payload.startsWith("GET_PHONE_NUMBER")) {
                                                                userInfo.last_message = "GET_PHONE_NUMBER";
                                                                facebookBot.sendFBMessage(event.sender.id, '{text: "Bạn ơi cho Mr. Colgate thêm Số điện thoại nữa nha!^^"}');
                                                                facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user;
                                                            } 
                                                            else if(payload.startsWith("GET_EMAIL")) {
                                                                userInfo.last_message = "GET_EMAIL";
                                                                facebookBot.sendFBMessage(event.sender.id, '{text: "Thêm một thông tin cuối cùng nữa thôi nè, Email của bạn là gì?"}');
                                                                facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user;
                                                            }
                                                            else {
                                                                 facebookBot.processMessageEvent(event);
                                                            }
                                                        } // quick_reply
                                                        else if (event.message.text) {

                                                            if(event.message.text == "Bình chọn") {

                                                                facebookBot.beforeVoteForUser();
                                                                    
                                                            }                                                         
                                                            else {
                                                                 switch(userInfo.last_message) {
                                                                    
                                                                    case "GET_VOTE_ID":

                                                                        var re = new RegExp("^[0-9]{6}([ .-])([0-9]{1})$");
                                                                        if (re.test(event.message.text)) {
                                                                           facebookBot.voteforUser(event.message.text);  
                                                                          
                                                                        } else {

                                                                            var text_resp = "Mã bài dự thi \"" + event.message.text + "\" vừa nhập không đúng. " + userInfo.last_name + " " + userInfo.first_name + " hãy kiểm tra lại nhé.";
                                                                            var text_mess = {
                                                                                text: text_resp
                                                                            }   

                                                                            var quick_reply_mess = {
                                                                                    text: "Mã số dự thi có dạng: 123456-1 \nTrong đó 123456 là mã thí sinh; 1 là số thứ tự của bài dự thi. \nVd: 123456-1",
			                                                                        quick_replies: [
			                                                                          {
			                                                                            "content_type": "text",
			                                                                            "title": "Thử lại",
			                                                                            "payload": "Bình chọn"
			                                                                          },
			                                                                          {
			                                                                            "content_type": "text",
			                                                                            "title":  "VỀ MENU CHÍNH",
			                                                                            "payload": "BACK_TO_MENU"
			                                                                          }                                                                         
			                                                                        ]
			                                                                    };

                                                                            var arrayMess =[];
                                                                            arrayMess.push(text_mess);
                                                                            arrayMess.push(quick_reply_mess);                                                                                   
                                                                            

			                                                                userInfo.last_message = "";   	
			                                                                facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user;	
			                                                                facebookBot.sendFBMultiMessage(event.sender.id, arrayMess);
                                                                        }
            
                                                                        break;

                                                                    case "GET_USER_NAME":

                                                                        userInfo.user_name = event.message.text;
                                                                        userInfo.last_message = "GET_PHONE_NUMBER";
                                                                        facebookBot.sendFBMessage(event.sender.id, '{text: "Bạn ơi cho Mr. Colgate thêm Số điện thoại nữa nha!^^"}');
                                                                        facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user;
                                                                        break;

                                                                    case "GET_PHONE_NUMBER":

                                                                        userInfo.phone = event.message.text;
                                                                        var re = new RegExp("^(01[2689]|09|08)[0-9]{8}$");
                                                                        if (!re.test(userInfo.phone)) {

                                                                             var quick_reply_mess = {
                                                                                    text: "Số điện thoại không hợp lệ. Vui lòng nhập số điện thoại hợp lệ của bạn",
                                                                                    quick_replies: [
                                                                                      {
                                                                                        "content_type": "text",
                                                                                        "title": "Thử lại",
                                                                                        "payload": "GET_PHONE_NUMBER"
                                                                                      },
                                                                                      {
                                                                                        "content_type": "text",
                                                                                        "title":  "VỀ MENU CHÍNH",
                                                                                        "payload": "BACK_TO_MENU"
                                                                                      }                                                                         
                                                                                    ]
                                                                                };

                                                                            userInfo.last_message = "";                                                                            
                                                                            facebookBot.sendFBMessage(event.sender.id, quick_reply_mess);
                                                                            facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user;
                                                                        } else {
                                                                            userInfo.last_message = "GET_EMAIL";
                                                                            facebookBot.sendFBMessage(event.sender.id, '{text: "Thêm một thông tin cuối cùng nữa thôi nè, Email của bạn là gì?"}');
                                                                            facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user;
                                                                        } 
                                                                        break;

                                                                    case "GET_EMAIL":

                                                                       
                                                                        userInfo.last_message = "";
                                                                        var email = event.message.text;
                                                                        var re = new RegExp("^\\w+@[a-zA-Z_]+?\\.[a-zA-Z]{2,3}$");
                                                                        if (!re.test(email)) {

                                                                             var quick_reply_mess = {
                                                                                    text: "Email không hợp lệ. Vui lòng nhập email lệ của bạn",
                                                                                    quick_replies: [
                                                                                      {
                                                                                        "content_type": "text",
                                                                                        "title": "Thử lại",
                                                                                        "payload": "GET_EMAIL"
                                                                                      },
                                                                                      {
                                                                                        "content_type": "text",
                                                                                        "title":  "VỀ MENU CHÍNH",
                                                                                        "payload": "BACK_TO_MENU"
                                                                                      }                                                                         
                                                                                    ]
                                                                                };

                                                                            userInfo.last_message = "";
                                                                            facebookBot.sendFBMessage(event.sender.id, quick_reply_mess);
                                                                          
                                                                        } else {
                                                                        	if(userInfo.flagVote && userInfo.flagVote === true) {// Ket thuc viec bau chon
                                                                                   
                                                                                userInfo.flagVote = false;                                                         		  
                                                                        		userInfo.open_gift = false;
                                                                        		var text_rep = "Chúc mừng bạn " + userInfo.last_name + " " + userInfo.first_name + " đã bình chọn thành công cho mã bài dự thi "
                                                                           		 + userInfo.vote_id + " \nMã bài dự thi " + userInfo.vote_id + " đang có " + Math.floor((Math.random() * 100) + 1)  + " điểm và đang xếp hạng thứ " + Math.floor((Math.random() * 10) + 1);
			                                                                    var text_mess = {
			                                                                        text: text_rep
			                                                                    };	

			                                                                    var quick_reply_mess= {
			                                                                        text: "Mr. Colgate gửi tặng bạn 1 lượt nhận \"QUÀ MAY MẮN\" nè ^^",
			                                                                        quick_replies: [
			                                                                          {
			                                                                            "content_type": "text",
			                                                                            "title": "Nhận quà",
			                                                                            "payload": "SHOW_GIFT"
			                                                                          },
			                                                                          {
			                                                                            "content_type": "text",
			                                                                            "title": "Bỏ qua",
			                                                                            "payload": "BACK_TO_MENU"
			                                                                          }
			                                                                        ]
			                                                                    };

			                                                                    var arrayMess =[];
		                                                                        arrayMess.push(text_mess);
		                                                                        arrayMess.push(quick_reply_mess);			                                                                        
                                                                           		facebookBot.sendFBMultiMessage(event.sender.id, arrayMess);
 																				
                                                                        	} else { // Thông báo nộp bài thành công
 																				 userInfo.email = email;
	                                                                         	facebookBot.beforeConfirmUpload(userInfo.attachment);
	                                                                        }
                                                                        }

                                                                        facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user;

                                                                        
                                                                        break;

                                                                    default:
                                                                        facebookBot.processMessageEvent(event);
                                                                }
                                                            }
                                                        } // end text
                                                               

                                                    } // end turn_on
                                                }
                                                else if(event.message.is_echo) { // Tinh nang bat tat Chat bot

                                                    if(event.message.text ===  "TURN_OFF") {

                                                        delete userInfo._id;
                                                        userInfo.turn_on = false;
                                                        facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user;

                                                    } else if(event.message.text ===  "TURN_ON"){

                                                        delete userInfo._id;
                                                        userInfo.turn_on = true;
                                                        facebookBot.updateToDb(userInfo, "user", userInfo.sender); // Cap nhat thong tin cua user;

                                                    }
                                                   
                                                }
                                            }  

                                        } else { // neu ko co thi luu thong tin user nay lai
                                        
                                            request({
                                                method: 'GET',
                                                uri: `https://graph.facebook.com/v2.6/${sender_id}/?access_token=${FB_PAGE_ACCESS_TOKEN}`,
                                                
                                            },
                                            (error, response, body) => {
                                                if (error) {
                                                    console.error('Error while get sender id info', error);
                                                } else {

                                                    const data = JSONbig.parse(response.body);
                                                    data.sender = sender_id;
                                                    data.turn_on = true; // bat tat tinh nang cua chat bot
                                                    data.upload = false; // danh dau la da upload bai du thi
                                                    data.finish_update = false; // danh dau la nguoi dung da upload bai hat va cap nhat thong tin
                                                    data.open_gift = false; // mơ 
                                                    data.user_name = "";
                                                    data.phone = "";
                                                    data.email = ""; 

                                                    // request({
                                                    //     method: 'GET',
                                                    //     uri: `https://graph.facebook.com/v2.9/${sender_id}/ids_for_apps?access_token=${FB_PAGE_ACCESS_TOKEN}`,
                                                        
                                                    // },
                                                    // (error_2, response_2, body_2) => {
                                                    //     if (error_2) {
                                                    //         console.error('Error while get sender id info', error_2);
                                                    //     } else {
                                                    //         const data_2 = JSONbig.parse(response_2.body);
                                                    //         if(data_2.data[0].id){
                                                    //             data.app_id = data_2.data[0].id;
                                                    //         } else {
                                                    //             data.app_id = null;
                                                    //         }
                                                    //     }
                                                    // });

                                                    facebookBot.updateToDb(data, "user", sender_id); // lưu thông tin người dùng
                                                    // XU LY CHO LAN DAU TIEN
                                                    facebookBot.userInfo = data;
                                                    facebookBot.processMessageEvent(event);
                                                }
                                            });
                                        }

                                   } else { // end lay thong tin nguoi dung
                                        console.log("GET_USER_ERROR:" + error);
                                   }
                                })
                            }
                            else { // end ket noi db
                                console.log( "CONNECT_DB_FAIL:" + err);
                            }
                            db.close();
                        });

                    });
                }
            });
        }

        return res.status(200).json({
            status: "ok"
        });
    } catch (err) {
        return res.status(400).json({
            status: "error",
            error: err
        });
    }

});

app.listen(REST_PORT, () => {
    console.log('Rest service ready on port ' + REST_PORT);
});

facebookBot.doSubscribeRequest();
