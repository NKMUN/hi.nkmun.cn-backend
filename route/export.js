const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const CsvStringify = require('csv-stringify')

const GV = (obj, key) => {
    let keys = key.split('.')
    let cur = obj
    for (let key of keys) {
        if (cur && cur[key]) {
          cur = cur[key]
        } else {
          return ''
        }
    }
    return cur
}

const isLeaderText = val => {
    return val ? '领队' : ''
}

const withdrawText = val => {
    return val ? '退会' : ''
}

const genderText = val => {
    switch (val) {
        case 'm': return '男'
        case 'f': return '女'
        default:  return ''
    }
}

const idTypeText = val => {
    switch (val) {
        case 'mainland': return '中国大陆身份证'
        case 'sar':      return '港澳'
        case 'taiwan':   return '台胞证'
        case 'passport': return '护照'
        case 'other':    return '其它'
        default:         return ''
    }
}

const guardianTypeText = val => {
    switch(val) {
        case 'father': return '父'
        case 'mother': return '母'
        case 'other':  return '其他'
    }
}

const REPRESENTATIVE = {
    columns: [
        '领队标记',
        '退会标记',
        '学校',
        '姓名',
        '性别',
        '手机',
        '邮箱',
        '毕业时间',
        '证件类型',
        '证件号码',
        '监护人关系',
        '监护人姓名',
        '监护人手机',
        '监护人证件类型',
        '监护人证件号码'
    ],
    map: $ => [
       isLeaderText( GV($, 'is_leader') ),
       withdrawText( GV($, 'withdraw') ),
       GV($, 'school.school.name'),
       GV($, 'session.name'),
       GV($, 'contact.name'),
       genderText( GV($, 'contact.gender') ),
       GV($, 'contact.phone'),
       GV($, 'contact.email'),
       GV($, 'graduation_year'),
       idTypeText( GV($, 'identification.type') ),
       GV($, 'identification.number'),
       guardianTypeText( GV($, 'guardian.type') ),
       GV($, 'guardian.name'),
       GV($, 'guardian.phone'),
       idTypeText( GV($, 'guardian_identification.type') ),
       GV($, 'guardian_identification.number'),
    ]
}

const BILLING = {
    columns: [ '学校', '类别', '项目', '数量/天数', '单价', '总价' ],
    map: $ => [
        GV($, 'paid_by.school.name'),
        GV($, 'items.type'),
        GV($, 'items.name'),
        GV($, 'items.amount'),
        GV($, 'items.price'),
        GV($, 'items.sum'),
    ]
}

const RESERVATION = {
    columns: [
        '学校',
        '酒店',
        '房型',
        '入住日期',
        '退房日期',
    ],
    map: $ => [
        GV($, 'school.school.name'),
        GV($, 'hotel.name'),
        GV($, 'hotel.type'),
        GV($, 'checkIn'),
        GV($, 'checkOut'),
    ]
}

const createCsvStream = (cursor, columns, map) => {
    const stream = new CsvStringify()
    stream.write(columns)
    cursor.each( (err, $) => {
        if ($)
            stream.write( map($) )
        else
            stream.end()
    })
    return stream
}


const LOOKUP_REPRESENTATIVE = [
    { $lookup: {
        localField: 'school',
        foreignField: '_id',
        from: 'school',
        as: 'school',
    } },
    { $lookup: {
        localField: 'session',
        foreignField: '_id',
        from: 'session',
        as: 'session',
    } },
    { $unwind: '$school' },
    { $unwind: '$session' }
]

const LOOKUP_RESERVATION = [
    { $lookup: {
        from: 'hotel',
        localField: 'hotel',
        foreignField: '_id',
        as: 'hotel'
    }},
    { $lookup: {
        from: 'school',
        localField: 'school',
        foreignField: '_id',
        as: 'school'
    } },
    { $unwind: '$hotel' },
    { $unwind: '$school' }
]

route.get('/export/representatives',
    AccessFilter('admin', 'root'),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('representative').aggregate(LOOKUP_REPRESENTATIVE),
            REPRESENTATIVE.columns,
            REPRESENTATIVE.map
        )
    }
)

route.get('/export/leaders',
    AccessFilter('admin', 'root'),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('representative').aggregate([
                { $match: { 'is_leader': true } },
                ... LOOKUP_REPRESENTATIVE
            ]),
            REPRESENTATIVE.columns,
            REPRESENTATIVE.map
        )
    }
)

route.get('/export/billings',
    AccessFilter('admin', 'root'),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('billing').aggregate([
                { $unwind: '$items' }
            ]),
            BILLING.columns,
            BILLING.map
        )
    }
)

route.get('/export/reservations',
    AccessFilter('admin', 'root'),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('reservation').aggregate(LOOKUP_RESERVATION),
            RESERVATION.columns,
            RESERVATION.map
        )
    }
)

module.exports = {
    routes: route.routes()
}
