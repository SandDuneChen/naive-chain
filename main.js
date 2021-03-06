'use strict';
var CryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var WebSocket = require("ws");

var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];

// Block的结构，其中hash字段保存的是其它字段拼接后的hash
class Block {
    constructor(index, previousHash, timestamp, data, hash) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.hash = hash.toString();
    }
}

// peers
var sockets = [];
// 消息类型
var MessageType = {
    QUERY_LATEST: 0,
    QUERY_ALL: 1,
    RESPONSE_BLOCKCHAIN: 2
};

// 创世块
var getGenesisBlock = () => {
    return new Block(0, "0", 1465154705, "my genesis block!!", "816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7");
};

// 初始化区块链，并将创世块做为第一个块
var blockchain = [getGenesisBlock()];

// 初始化Http Server，响应客户端的请求
var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));
    app.post('/mineBlock', (req, res) => {
        console.log("Received data from client: " + req.body.data);
        var newBlock = generateNextBlock(req.body.data);
        addBlock(newBlock);
        broadcast(responseLatestMsg());
        console.log('block added: ' + JSON.stringify(newBlock));
        res.send();
    });
    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });
    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });
    app.listen(http_port, () => console.log('Listening http on port: ' + http_port));
};

// 初始化连接
var initConnection = (ws) => {
    // 当前连接（peer）存入数组
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    // 向对端发送数据，数据内容是消息类型：MessageType.QUERY_LATEST
    write(ws, queryChainLengthMsg());
};

// 初始化P2P Server
var initP2PServer = () => {
    var server = new WebSocket.Server({port: p2p_port});
    // 创建一个WS Server监听请求，每从有新的连接进入便初始化一个WebSocket实例
    server.on('connection', (ws) => initConnection(ws));
    console.log('listening websocket p2p port on: ' + p2p_port);
};

// 建立与peer的连接
var connectToPeers = (newPeers) => {
    console.log(newPeers);
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed')
        });
    });
};

// 收到消息时，根据消息类型进行处理操作
var initMessageHandler = (ws) => {
    ws.on('message', (data) => { // 接收到消息时处理
        var message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST: // 返回最新的块数据
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL: // 返回整个链上的块数据
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN: // 收到整个链数据的查询响应，进行下一步处理
                handleBlockchainResponse(message);
                break;
        }
    });
};

// 初始化错误处理
var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        // 删除出错的peer
        sockets.splice(sockets.indexOf(ws), 1);
    };
    // 以下两种情况都关闭连接
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};

// 产生并返回下一个区块
var generateNextBlock = (blockData) => {
    var previousBlock = getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = new Date().getTime() / 1000;
    var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData);
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash);
};


// 计算块的hash
var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data);
};

// 计算传入各参数拼接后的hash
var calculateHash = (index, previousHash, timestamp, data) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + data).toString();
};

// 如果新生成的区块合法则加入链上，
var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
    }
};

// 根据上一区块，验证当前区块（newBlock）是否合法
var isValidNewBlock = (newBlock, previousBlock) => {
    // 当前区块的index + 1
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    // 当前区块的previousHash指向前一区块
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    // 计算当前区块的hash值并与块中保存的hash值比对，判断是否一致
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};


var handleBlockchainResponse = (message) => {
    // 按块高（index大小）升序排序
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1]; // peer节点上最新的块
    var latestBlockHeld = getLatestBlock(); // 本地链上最新的块
    if (latestBlockReceived.index > latestBlockHeld.index) { // 本地链长小于peer节点链（本地节点数据落后）
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) { // 比本地链多的最新块正好是下一个块，直接追加
            console.log("We can append the received block to our chain");
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1) { // 只有一个节点，需要向peer节点广播查询所有块数据
            console.log("We have to query the chain from our peer");
            broadcast(queryAllMsg());
        } else { // 本地链落后节点链很多块，进行替换操作
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is not longer than received blockchain. Do nothing');
    }
};

// 使用新的链blocks替换本地的链blocks
var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

// 检查链blocks是否合法
var isValidChain = (blockchainToValidate) => {
    // 第一个块必须是创世块
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

// 最新的块数据
var getLatestBlock = () => blockchain[blockchain.length - 1];

// 查询最新的块
var queryChainLengthMsg = () => ({'type': MessageType.QUERY_LATEST});

// 查询所有块
var queryAllMsg = () => ({'type': MessageType.QUERY_ALL});

// 整个链上的所有块
var responseChainMsg = () =>({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify(blockchain)
});

// 当前最新的块
var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

// 向连接节点发送消息
var write = (ws, message) => ws.send(JSON.stringify(message));
// 广播--向所有peers节点发送消息
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

connectToPeers(initialPeers);
initHttpServer();
initP2PServer();
