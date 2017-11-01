var express = require('express');
var bodyParser = require('body-parser');


var http_port = process.env.HTTP_PORT || 4000;

var app = express();
app.use(bodyParser.json());


app.post('/mineBlock', (req, res, next) => {
    console.log("Received data from client: body.data" );
    console.log(req.body.data);
    console.log("Received data from client: params" );
    console.log(req.params);
    console.log("Received data from client: query" );
    console.log(req.query);
    res.send();
});


app.listen(http_port, () => console.log('Listening http on port: ' + http_port));
